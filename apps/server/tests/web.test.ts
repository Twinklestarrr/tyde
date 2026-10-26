import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import { registerWeb } from '../src/web.js';

const config = readConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/unused_test',
  CODE_HMAC_SECRET: 'x'.repeat(32),
  SMS_PROVIDER: 'mock',
  WEB_ORIGINS: 'http://127.0.0.1:3000',
  LOG_LEVEL: 'silent',
});

test('standalone server serves Web with caching while preserving API and Swagger routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-web-'));
  const root = join(directory, 'public');
  const app = await createApp(config);
  try {
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html><title>tyde</title>');
    await writeFile(join(root, 'assets', 'index-abc123.js'), 'console.log("tyde")');
    await writeFile(join(root, 'assets', 'index-abc123.css'), 'body { color: black }');
    await writeFile(join(directory, 'private.txt'), 'server secret');
    await writeFile(join(root, '.env'), 'hidden secret');
    await registerWeb(app, root);

    for (const url of ['/', '/index.html']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('<title>tyde</title>');
      expect(response.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers['last-modified']).toBeUndefined();
    }
    for (const extension of ['js', 'css']) {
      const response = await app.inject(`/assets/index-abc123.${extension}`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(
        extension === 'js' ? 'javascript' : 'text/css',
      );
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
    expect((await app.inject('/api/v1/health/live')).json().status).toBe('ok');
    expect((await app.inject('/api/v1/docs/')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/docs/static/swagger-ui-bundle.js')).statusCode).toBe(200);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    expect(spec.paths['/api/v1/users/me']).toBeDefined();
    expect(spec.paths['/*']).toBeUndefined();
    for (const url of ['/api/v1/not-found', '/assets/missing.js', '/missing-page']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).not.toContain('<!doctype html>');
    }
    for (const url of ['/.env', '/assets/%2e%2e/%2e%2e/private.txt']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain('secret');
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('same-size HTML deployments with normalized mtimes ignore old browser validators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tyde-web-version-'));
  const app = await createApp(config);
  try {
    const index = join(root, 'index.html');
    const modified = new Date('2018-10-20T01:46:40Z');
    const oldHtml = '<script src="/assets/old123.js"></script>';
    const newHtml = '<script src="/assets/new456.js"></script>';
    expect(Buffer.byteLength(newHtml)).toBe(Buffer.byteLength(oldHtml));
    await writeFile(index, oldHtml);
    await utimes(index, modified, modified);
    await registerWeb(app, root);
    expect((await app.inject('/')).body).toBe(oldHtml);
    await writeFile(index, newHtml);
    await utimes(index, modified, modified);

    const oldEtag = `W/"${Buffer.byteLength(oldHtml).toString(16)}-${modified.getTime().toString(16)}"`;
    for (const url of ['/', '/index.html']) {
      for (const headers of [
        { 'if-none-match': oldEtag },
        { 'if-modified-since': modified.toUTCString() },
      ]) {
        const response = await app.inject({ url, headers });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(newHtml);
      }
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('API development still starts before Web has been built', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyde-api-only-'));
  const app = await createApp(config);
  try {
    await registerWeb(app, join(directory, 'missing'));
    expect((await app.inject('/api/v1/health/live')).statusCode).toBe(200);
    expect((await app.inject('/')).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
