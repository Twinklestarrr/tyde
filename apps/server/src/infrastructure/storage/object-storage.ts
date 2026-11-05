import OSS from 'ali-oss';
import { PassThrough, type Readable } from 'node:stream';
import { AppError } from '../../common/errors.js';
import type { FileConfig } from '../../config/files.js';

// API/台账使用相对业务键；只有 OSS 适配器负责添加项目物理目录。
export const OSS_OBJECT_PREFIX = 'tyde';

export interface ObjectStorage {
  put(key: string, content: Buffer, contentType: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  open(key: string): Promise<{ stream: Readable; size: number; contentType: string }>;
  delete(key: string): Promise<void>;
  accessUrl(key: string, seconds: number): string;
}
export function validObjectKey(key: string): string {
  const value = key.trim();
  if (
    !value ||
    value.length > 512 ||
    !/^[a-z0-9-]+\/[a-zA-Z0-9/_.-]+$/.test(value) ||
    value.split('/').some((s) => !s || s === '.' || s === '..')
  )
    throw new AppError(400, 'BAD_REQUEST', 'objectKey 格式不正确');
  return value;
}
const unavailable = () => new AppError(503, 'STORAGE_UNAVAILABLE', '文件存储未配置或暂不可用');

/** SDK V1 签名兼容旧图片有效期；服务端读写与客户端签名分别使用内/外网端点。 */
type OssClient = Pick<OSS, 'put' | 'head' | 'getStream' | 'delete' | 'signatureUrl'>;
type ClientFactory = (options: OSS.Options) => OssClient;

function missingObject(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { code, status } = error as { code?: string; status?: number };
  return code === 'NoSuchKey' || (status === 404 && !code);
}
function objectSize(headers: object): number {
  const value = (headers as Record<string, unknown>)['content-length'];
  const size = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(size) || size < 0) throw unavailable();
  return size;
}

export class OssObjectStorage implements ObjectStorage {
  private readonly client: OssClient;
  private readonly signer: OssClient;
  constructor(config: FileConfig, factory: ClientFactory = (options) => new OSS(options)) {
    const options: OSS.Options = {
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      secure: true,
      timeout: 30_000,
      authorizationV4: false,
    };
    this.client = factory({ ...options, endpoint: config.endpoint });
    this.signer = factory({ ...options, endpoint: config.publicEndpoint });
  }
  async put(key: string, content: Buffer, contentType: string) {
    key = `${OSS_OBJECT_PREFIX}/${validObjectKey(key)}`;
    try {
      await this.client.put(key, content, {
        mime: contentType,
        headers: { 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' },
      });
    } catch {
      throw unavailable();
    }
  }
  async head(key: string) {
    key = `${OSS_OBJECT_PREFIX}/${validObjectKey(key)}`;
    let result;
    try {
      result = await this.client.head(key);
    } catch (error) {
      if (missingObject(error)) return null;
      throw unavailable();
    }
    return { size: objectSize(result.res.headers) };
  }
  async open(key: string) {
    key = `${OSS_OBJECT_PREFIX}/${validObjectKey(key)}`;
    let result;
    try {
      result = await this.client.getStream(key);
    } catch (error) {
      if (missingObject(error)) throw new AppError(404, 'NOT_FOUND', '文件不存在');
      throw unavailable();
    }
    const source = result.stream;
    if (!source) throw unavailable();
    let size: number;
    try {
      size = objectSize(result.res.headers);
    } catch {
      source.destroy();
      throw unavailable();
    }
    // 下载开始后的 SDK 错误也不能将上游请求/签名等细节传播到 HTTP 响应或日志。
    const stream = new PassThrough();
    source.on('error', () => stream.destroy(unavailable()));
    source.on('close', () => {
      if (!source.readableEnded) stream.destroy(unavailable());
    });
    stream.on('close', () => source.destroy());
    source.pipe(stream);
    const contentType = (result.res.headers as Record<string, unknown>)['content-type'];
    return {
      stream,
      size,
      contentType: typeof contentType === 'string' ? contentType : 'application/octet-stream',
    };
  }
  async delete(key: string) {
    key = `${OSS_OBJECT_PREFIX}/${validObjectKey(key)}`;
    try {
      await this.client.delete(key);
    } catch (error) {
      if (!missingObject(error)) throw unavailable();
    }
  }
  accessUrl(key: string, seconds: number) {
    key = `${OSS_OBJECT_PREFIX}/${validObjectKey(key)}`;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 2147483647)
      throw new AppError(400, 'BAD_REQUEST', '访问链接有效期不正确');
    try {
      return this.signer.signatureUrl(key, { expires: seconds, method: 'GET' });
    } catch {
      throw unavailable();
    }
  }
}

export function createObjectStorage(config: FileConfig): ObjectStorage {
  if (config.provider === 'oss') return new OssObjectStorage(config);
  return {
    async put() {
      throw unavailable();
    },
    async head() {
      throw unavailable();
    },
    async open() {
      throw unavailable();
    },
    async delete() {
      throw unavailable();
    },
    accessUrl() {
      throw unavailable();
    },
  };
}
