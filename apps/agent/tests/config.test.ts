import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';

test('Agent 配置默认仅监听回环地址，并允许显式覆盖', () => {
  assert.deepEqual(readConfig({}), {
    env: 'development',
    host: '127.0.0.1',
    port: 3002,
    auth: { mode: 'disabled' },
    storage: { mode: 'postgres' },
  });
  assert.deepEqual(
    readConfig({ NODE_ENV: 'production', AGENT_HOST: '0.0.0.0', AGENT_PORT: '43002' }),
    {
      env: 'production',
      host: '0.0.0.0',
      port: 43002,
      auth: { mode: 'disabled' },
      storage: { mode: 'postgres' },
    },
  );
  assert.equal(readConfig({ AGENT_HOST: '::1' }).host, '::1');
});

const developmentIdentity = {
  AGENT_AUTH_MODE: 'development',
  AGENT_TEST_USER_ID: 'test-user',
  AGENT_TEST_BEARER_TOKEN: 'test-only-token-0123456789-abcdef-0123456789',
};

test('开发身份必须显式启用并提供服务端用户和凭证，开发与测试均可使用', () => {
  for (const env of ['development', 'test']) {
    const config = readConfig({ ...developmentIdentity, NODE_ENV: env });
    assert.deepEqual(config.auth, {
      mode: 'development',
      userId: developmentIdentity.AGENT_TEST_USER_ID,
      bearerToken: developmentIdentity.AGENT_TEST_BEARER_TOKEN,
    });
    assert.equal(readConfig({ ...developmentIdentity, AGENT_HOST: '::1' }).host, '::1');
  }
  assert.equal(
    readConfig({ ...developmentIdentity, AGENT_AUTH_MODE: 'disabled' }).auth.mode,
    'disabled',
  );
});

test('开发身份不能在生产或非字面回环地址启用，也不能缺失、使用弱格式配置', () => {
  assert.throws(() => readConfig({ ...developmentIdentity, NODE_ENV: 'production' }), /production/);
  for (const host of ['0.0.0.0', '::', '192.0.2.1', 'localhost']) {
    assert.throws(() => readConfig({ ...developmentIdentity, AGENT_HOST: host }), /AGENT_HOST/);
  }
  assert.throws(() => readConfig({ AGENT_AUTH_MODE: 'platform' }), /AGENT_AUTH_MODE/);
  for (const userId of ['', ' user', 'user name', 'user\nname', 'a'.repeat(129), '\ud800']) {
    assert.throws(
      () => readConfig({ ...developmentIdentity, AGENT_TEST_USER_ID: userId }),
      /AGENT_TEST_USER_ID/,
    );
  }
  for (const token of ['', 'short', 'a'.repeat(31), `${'a'.repeat(32)} `, `${'a'.repeat(32)}\n`]) {
    assert.throws(
      () => readConfig({ ...developmentIdentity, AGENT_TEST_BEARER_TOKEN: token }),
      /AGENT_TEST_BEARER_TOKEN/,
    );
  }
});

test('无效环境、监听地址或端口在启动前拒绝', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'staging' }), /NODE_ENV/);
  for (const host of ['', 'https://localhost', '127.0.0.1:3002', 'local host', 'local..host']) {
    assert.throws(() => readConfig({ AGENT_HOST: host }), /AGENT_HOST/);
  }
  for (const port of ['', '0', '-1', '65536', '3.5', '3002abc', ' 3002']) {
    assert.throws(() => readConfig({ AGENT_PORT: port }), /AGENT_PORT/);
  }
});

test('PostgreSQL is the default and memory requires explicit nonproduction selection', () => {
  assert.deepEqual(readConfig({}).storage, { mode: 'postgres' });
  assert.deepEqual(readConfig({ AGENT_STORAGE_MODE: 'memory' }).storage, { mode: 'memory' });
  assert.throws(() => readConfig({ AGENT_STORAGE_MODE: 'other' }), /AGENT_STORAGE_MODE/);
  assert.throws(
    () => readConfig({ NODE_ENV: 'production', AGENT_STORAGE_MODE: 'memory' }),
    /production/,
  );
});
