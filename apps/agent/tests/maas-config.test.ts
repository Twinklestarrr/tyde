import assert from 'node:assert/strict';
import test from 'node:test';
import { readMaasConfig } from '../src/maas/index.js';

export const maasEnvironment = {
  AGENT_MAAS_BASE_URL: 'http://127.0.0.1:39002/internal/agent-maas/v1',
  AGENT_MAAS_MODEL_ID: 'isolated-model',
  AGENT_MAAS_ACTUAL_MODEL_IDS: '["isolated-model-v1"]',
  AGENT_MAAS_ROUTE_VERSION: 'isolated-route-v1',
  AGENT_MAAS_SERVICE_TOKEN: 'isolated-service-credential',
  AGENT_MAAS_CONTEXT_WINDOW: '8192',
  AGENT_MAAS_MAX_TOKENS: '1024',
  AGENT_MAAS_COMPAT: JSON.stringify({
    supportsStore: false,
    supportsDeveloperRole: true,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    thinkingFormat: 'openai',
  }),
};

test('MaaS 缺少真实配置时只报告键名，不补示例模型、路由或凭据', () => {
  assert.throws(() => readMaasConfig({}), /AGENT_MAAS_BASE_URL.*AGENT_MAAS_MODEL_ID/);
  const missing: NodeJS.ProcessEnv = { ...maasEnvironment };
  delete missing.AGENT_MAAS_SERVICE_TOKEN;
  assert.throws(() => readMaasConfig(missing), /^Error: MaaS 配置缺失：AGENT_MAAS_SERVICE_TOKEN$/);
  const config = readMaasConfig(maasEnvironment);
  assert.equal(config.compat.maxTokensField, 'max_tokens');
  assert.deepEqual(config.actualModelIds, ['isolated-model-v1']);
  assert.equal(config.timeouts.totalMs, 180_000);
  assert.equal(config.timeouts.connectMs, 3_000);
  assert.equal(
    readMaasConfig({ ...maasEnvironment, AGENT_MAAS_CONNECT_TIMEOUT_MS: '17' }).timeouts.connectMs,
    17,
  );
  assert.throws(
    () => readMaasConfig({ ...maasEnvironment, AGENT_MAAS_CONNECT_TIMEOUT_MS: '0' }),
    /CONNECT_TIMEOUT_MS/,
  );
});

test('MaaS 锁定平台路径，HTTP 仅允许回环隔离测试', () => {
  for (const url of [
    'https://example.test/v1',
    'https://example.test/internal/agent-maas/v1/chat/completions',
    'http://example.test/internal/agent-maas/v1',
    'https://token@example.test/internal/agent-maas/v1',
    'https://example.test/internal/agent-maas/v1?model=other',
  ])
    assert.throws(
      () => readMaasConfig({ ...maasEnvironment, AGENT_MAAS_BASE_URL: url }),
      /AGENT_MAAS_BASE_URL/,
    );
  assert.equal(
    readMaasConfig({
      ...maasEnvironment,
      AGENT_MAAS_BASE_URL: 'https://platform.example.test/internal/agent-maas/v1/',
    }).baseUrl,
    'https://platform.example.test/internal/agent-maas/v1',
  );
});

test('MaaS compat 必须逐项显式提供并拒绝未知能力和宽松结束规则', () => {
  for (const compat of [
    {},
    { ...JSON.parse(maasEnvironment.AGENT_MAAS_COMPAT), supportsFinishReason: false },
    { ...JSON.parse(maasEnvironment.AGENT_MAAS_COMPAT), unknownCapability: true },
  ]) {
    assert.throws(
      () => readMaasConfig({ ...maasEnvironment, AGENT_MAAS_COMPAT: JSON.stringify(compat) }),
      /AGENT_MAAS_COMPAT/,
    );
  }
  assert.throws(
    () => readMaasConfig({ ...maasEnvironment, AGENT_MAAS_TOTAL_TIMEOUT_MS: '300001' }),
    /300000/,
  );
  assert.throws(
    () => readMaasConfig({ ...maasEnvironment, AGENT_MAAS_SERVICE_TOKEN: 'bad\ncredential' }),
    /SERVICE_TOKEN/,
  );
  assert.throws(
    () => readMaasConfig({ ...maasEnvironment, AGENT_MAAS_MAX_TOKENS: '9000' }),
    /MAX_TOKENS/,
  );
});
