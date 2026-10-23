import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_HEALTH_PATH } from '@tyde/shared/agent';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config.js';

test('健康检查返回真实进程状态，OpenAPI 包含同一接口和中文字段说明', async (t) => {
  const app = await createApp(readConfig({ NODE_ENV: 'test', AGENT_STORAGE_MODE: 'memory' }));
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: AGENT_HEALTH_PATH });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { service: 'tyde-agent', status: 'ok' });

  const docsResponse = await app.inject({ method: 'GET', url: '/api/v1/docs/json' });
  assert.equal(docsResponse.statusCode, 200);
  const docs = docsResponse.json();
  const health = docs.paths[AGENT_HEALTH_PATH].get;
  assert.equal(health.operationId, 'agentHealthLive');
  const media = health.responses['200'].content['application/json'];
  const schema = media.schema;
  assert.deepEqual(media.example, response.json());
  for (const field of ['service', 'status']) {
    assert.match(schema.properties[field].description, /[\u4e00-\u9fff]/);
    assert.equal(schema.properties[field].example, response.json()[field]);
  }

  const unknown = await app.inject({ method: 'POST', url: '/api/v1/tasks' });
  assert.equal(unknown.statusCode, 404);
});
