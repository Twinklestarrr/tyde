import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/application.js';
import { requireOwnedConversation, type PlatformIdentityAdapter } from '../src/auth/access.js';
import { readConfig, type AgentConfig } from '../src/config.js';

const bearerToken = 'test-only-token-0123456789-abcdef-0123456789';
const developmentConfig = () =>
  readConfig({
    NODE_ENV: 'test',
    AGENT_STORAGE_MODE: 'memory',
    AGENT_AUTH_MODE: 'development',
    AGENT_TEST_USER_ID: 'server-owned-user',
    AGENT_TEST_BEARER_TOKEN: bearerToken,
  });

async function testApp(config = developmentConfig(), identityAdapter?: PlatformIdentityAdapter) {
  const app = await createApp(config, { identityAdapter });
  // 隔离替身路由仅存在于测试，不宣称已实现会话或命令 HTTP API。
  app.post('/__test/identity', async (request) => app.agentAccess.authenticate(request));
  const conversations = new Map([
    ['owned', { id: 'owned', ownerUserId: 'server-owned-user', deletedAt: null }],
    ['private', { id: 'private', ownerUserId: 'another-user', deletedAt: null }],
    [
      'deleted',
      { id: 'deleted', ownerUserId: 'server-owned-user', deletedAt: '2026-10-22T00:00:00Z' },
    ],
  ]);
  app.get<{ Params: { id: string } }>('/__test/conversations/:id', async (request) => {
    const principal = await app.agentAccess.authenticate(request);
    const conversation = requireOwnedConversation(principal, conversations.get(request.params.id));
    return { id: conversation.id };
  });
  return app;
}

test('开发身份仅由显式服务端配置与有效 Bearer 得到，忽略客户端自报身份', async (t) => {
  const app = await testApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/__test/identity?owner_user_id=another-user',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'x-user-id': 'another-user',
      'x-owner-user-id': 'another-user',
      cookie: 'user_id=another-user',
    },
    payload: { owner_user_id: 'another-user', user_id: 'another-user' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { userId: 'server-owned-user', source: 'development' });
  const lowerCaseScheme = await app.inject({
    method: 'POST',
    url: '/__test/identity',
    headers: { authorization: `bearer ${bearerToken}` },
  });
  assert.equal(lowerCaseScheme.statusCode, 200);
});

test('缺失、错误、多份或错误格式凭证均不能通过，自报用户不能代替身份', async (t) => {
  const app = await testApp();
  t.after(() => app.close());
  const attempts = [
    {},
    { authorization: 'Basic test' },
    { authorization: `Bearer ${bearerToken}-wrong` },
    { authorization: 'Bearer short' },
    { authorization: `Bearer  ${bearerToken}` },
    { authorization: [`Bearer ${bearerToken}`, `Bearer ${bearerToken}`] },
  ];
  for (const headers of attempts) {
    const response = await app.inject({
      method: 'POST',
      url: '/__test/identity',
      headers: { ...headers, 'x-user-id': 'server-owned-user' },
      payload: { owner_user_id: 'server-owned-user' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'UNAUTHENTICATED');
    assert.equal(response.body.includes(bearerToken), false);
  }
});

test('默认未装配授权时拒绝资源访问，健康检查与 Swagger 仍可匿名访问', async (t) => {
  const app = await testApp(readConfig({ NODE_ENV: 'test', AGENT_STORAGE_MODE: 'memory' }));
  t.after(() => app.close());
  const resource = await app.inject({
    method: 'POST',
    url: '/__test/identity',
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  assert.equal(resource.statusCode, 503);
  assert.equal(resource.json().code, 'SERVICE_UNAVAILABLE');
  for (const url of ['/health/live', '/api/v1/docs/json']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200);
  }
});

test('私有会话只允许本人，未知、其他用户与已删除会话统一 404', async (t) => {
  const app = await testApp();
  t.after(() => app.close());
  const owned = await app.inject({
    method: 'GET',
    url: '/__test/conversations/owned',
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  assert.equal(owned.statusCode, 200);
  assert.deepEqual(owned.json(), { id: 'owned' });
  const denied = await Promise.all(
    ['private', 'deleted', 'missing'].map((id) =>
      app.inject({
        method: 'GET',
        url: `/__test/conversations/${id}`,
        headers: { authorization: `Bearer ${bearerToken}`, 'x-owner-user-id': 'server-owned-user' },
      }),
    ),
  );
  for (const response of denied) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), denied[0]?.json());
    assert.equal(response.json().code, 'RESOURCE_NOT_FOUND');
  }
});

test('未来平台适配器仅从可信服务端注入，每次校验凭证并支持撤销，不回退测试身份', async (t) => {
  let valid = true;
  const received: string[] = [];
  const app = await testApp(readConfig({ NODE_ENV: 'test', AGENT_STORAGE_MODE: 'memory' }), {
    async authenticateBearer(token) {
      received.push(token);
      return valid ? { userId: 'platform-user' } : null;
    },
  });
  t.after(() => app.close());
  const request = {
    method: 'POST' as const,
    url: '/__test/identity',
    headers: { authorization: `Bearer ${bearerToken}`, 'x-user-id': 'server-owned-user' },
  };
  const accepted = await app.inject(request);
  assert.deepEqual(accepted.json(), { userId: 'platform-user', source: 'platform' });
  valid = false;
  assert.equal((await app.inject(request)).statusCode, 401);
  assert.deepEqual(received, [bearerToken, bearerToken]);
});

test('平台校验异常或非法用户标识均拒绝，且不暴露上游错误', async (t) => {
  for (const adapter of [
    {
      async authenticateBearer() {
        throw new Error(`upstream rejected secret ${bearerToken}`);
      },
    },
    {
      async authenticateBearer() {
        return { userId: '' };
      },
    },
  ]) {
    const app = await testApp(
      readConfig({ NODE_ENV: 'test', AGENT_STORAGE_MODE: 'memory' }),
      adapter,
    );
    t.after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/__test/identity',
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes(bearerToken), false);
    assert.equal(response.body.includes('upstream'), false);
  }
});

test('直接装配配置也不能绕过生产限制，开发与平台身份不能同时启用', async () => {
  const config: AgentConfig = { ...developmentConfig(), env: 'production' };
  await assert.rejects(() => createApp(config), /production/);
  await assert.rejects(() => createApp({ ...developmentConfig(), host: '0.0.0.0' }), /AGENT_HOST/);
  await assert.rejects(
    () =>
      createApp(developmentConfig(), {
        identityAdapter: {
          async authenticateBearer() {
            return null;
          },
        },
      }),
    /不能同时/,
  );
});
