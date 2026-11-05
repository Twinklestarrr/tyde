export interface FileConfig {
  provider: 'disabled' | 'oss';
  endpoint: string;
  publicEndpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  maxSize: number;
  maxRequestSize: number;
  maxBatchCount: number;
  urlExpireSeconds: number;
  unclaimedExpireSeconds: number;
  releasedExpireSeconds: number;
  cleanupBatchSize: number;
}

export function readFileConfig(source: NodeJS.ProcessEnv): FileConfig {
  const provider = source.FILE_STORAGE_PROVIDER ?? 'disabled';
  if (provider !== 'disabled' && provider !== 'oss')
    throw new Error('FILE_STORAGE_PROVIDER 配置无效');
  function positive(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) {
    const value = Number(source[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`${name} 配置无效`);
    return value;
  }
  function endpointUrl(value: string, name: string) {
    let url: URL;
    try {
      url = new URL(value.includes('://') ? value : `https://${value}`);
    } catch {
      throw new Error(`${name} 必须是无路径的 HTTPS 区域端点`);
    }
    if (
      url.protocol !== 'https:' ||
      !/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error(`${name} 必须是无路径的 HTTPS OSS 区域端点`);
    return url.origin;
  }
  let endpoint = source.OSS_ENDPOINT?.trim() ?? '';
  let publicEndpoint = source.OSS_PUBLIC_ENDPOINT?.trim() ?? '';
  const bucket = source.OSS_BUCKET ?? '';
  const accessKeyId = source.OSS_ACCESS_KEY_ID ?? '';
  const accessKeySecret = source.OSS_ACCESS_KEY_SECRET ?? '';
  if (provider === 'oss') {
    endpoint = endpointUrl(endpoint, 'OSS_ENDPOINT');
    publicEndpoint = endpointUrl(
      publicEndpoint || endpoint.replace('-internal.', '.'),
      'OSS_PUBLIC_ENDPOINT',
    );
    if (new URL(publicEndpoint).hostname.includes('-internal.'))
      throw new Error('OSS_PUBLIC_ENDPOINT 必须使用外网区域端点');
    if (publicEndpoint !== endpoint.replace('-internal.', '.'))
      throw new Error('OSS_PUBLIC_ENDPOINT 必须与 OSS_ENDPOINT 属于同一区域');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !accessKeyId || !accessKeySecret)
      throw new Error('请配置 OSS bucket 和访问密钥');
  }
  return {
    provider,
    endpoint,
    publicEndpoint,
    bucket,
    accessKeyId,
    accessKeySecret,
    maxSize: positive('TYDE_FILE_MAX_SIZE', 50 * 1024 * 1024, 2147483647),
    maxRequestSize: positive('TYDE_UPLOAD_MAX_REQUEST_SIZE', 100 * 1024 * 1024),
    maxBatchCount: positive('TYDE_FILE_MAX_BATCH', 10, 100),
    urlExpireSeconds: positive('TYDE_FILE_URL_EXPIRE', 604800, 2147483647),
    unclaimedExpireSeconds: positive('TYDE_FILE_UNCLAIMED_EXPIRE', 86400),
    releasedExpireSeconds: positive('TYDE_FILE_RELEASED_EXPIRE', 86400),
    cleanupBatchSize: positive('TYDE_FILE_CLEANUP_BATCH', 100, 1000),
  };
}
