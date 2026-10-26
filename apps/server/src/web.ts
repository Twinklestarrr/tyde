import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// src/ 与 dist/ 同级，独立部署时不依赖进程的工作目录。
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));

export async function registerWeb(app: FastifyInstance, root = publicRoot) {
  try {
    // 直接枚举固定 URL，让 Vercel 的文件追踪包含整个 Web 目录（含动态命名的资源）。
    const files =
      root === publicRoot
        ? await readdir(new URL('../public/', import.meta.url), { recursive: true })
        : await readdir(root, { recursive: true });
    if (!files.includes('index.html')) throw new Error('Web 构建产物缺少 index.html');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    app.log.info('未找到 Web 构建产物，仅提供 API；运行 pnpm build:server 可生成页面');
    return;
  }

  // Vercel 会归一化产物 mtime；同长度 HTML 的 stat ETag 可能跨版本相同。
  // 首页直接发送正文，忽略旧验证器；摘要资源继续使用静态插件与 immutable 缓存。
  for (const url of ['/', '/index.html']) {
    app.get(url, async (_request, reply) => {
      return reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'public, max-age=0, must-revalidate')
        .header('X-Content-Type-Options', 'nosniff')
        .send(await readFile(join(root, 'index.html')));
    });
  }

  await app.register(fastifyStatic, {
    root,
    decorateReply: false,
    cacheControl: false,
    dotfiles: 'deny',
    index: ['index.html'],
    setHeaders(response, path) {
      const asset = relative(root, path).startsWith(`assets${sep}`);
      response.setHeader(
        'Cache-Control',
        asset ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
      );
      response.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });
}
