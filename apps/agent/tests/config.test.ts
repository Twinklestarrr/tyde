import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';

test('Agent 配置默认仅监听回环地址，并允许显式覆盖', () => {
  assert.deepEqual(readConfig({}), { env: 'development', host: '127.0.0.1', port: 3002 });
  assert.deepEqual(
    readConfig({ NODE_ENV: 'production', AGENT_HOST: '0.0.0.0', AGENT_PORT: '43002' }),
    { env: 'production', host: '0.0.0.0', port: 43002 },
  );
  assert.equal(readConfig({ AGENT_HOST: '::1' }).host, '::1');
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
