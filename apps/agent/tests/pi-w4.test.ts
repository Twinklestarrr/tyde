import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nodeTest from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import type { MaasConfig } from '../src/maas/index.js';
import { AttemptBudget } from '../src/execution/attempt-budget.js';
import {
  createPiMemorySession,
  freezePiResources,
  resourceSha256,
  type PiMemoryTool,
  type PiToolLifecycle,
  type TrustedTextResource,
} from '../src/pi/index.js';

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 10_000 }, run);

const config: MaasConfig = {
  baseUrl: 'http://127.0.0.1/internal/agent-maas/v1',
  modelId: 'isolated-model',
  actualModelIds: ['isolated-model'],
  routeVersion: 'isolated-route-v1',
  serviceToken: 'isolated-service-token',
  contextWindow: 8192,
  maxTokens: 512,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    thinkingFormat: 'openai',
  },
  timeouts: { headersMs: 2000, firstProgressMs: 2000, idleMs: 2000, totalMs: 5000 },
};
const context = {
  conversationId: randomUUID(),
  taskId: randomUUID(),
  attemptId: randomUUID(),
  executionGeneration: '1',
  executionSnapshotId: randomUUID(),
  platformSubjectRef: 'test-subject',
};
const resource = (id: string, body: string): TrustedTextResource => ({
  id,
  version: '1',
  body,
  sha256: resourceSha256(body),
});
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'completion-w4-isolated',
  object: 'chat.completion.chunk',
  created: 1,
  model: config.modelId,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
function response(init: RequestInit | undefined, content: unknown[]) {
  return new Response(
    [...content, '[DONE]']
      .map((data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
      .join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-agent-model-request-id': new Headers(init?.headers).get('x-agent-model-request-id')!,
        'x-platform-request-id': 'isolated-request',
        'x-maas-route-version': config.routeVersion,
      },
    },
  );
}
const toolCall = (id = 'call-w4-one', args = '{"group":"empty"}') => [
  chunk({
    tool_calls: [{ index: 0, id, type: 'function', function: { name: 'lookup', arguments: args } }],
  }),
  chunk({}, 'tool_calls'),
];
const answer = (text = 'done') => [chunk({ content: text }), chunk({}, 'stop')];
function lookup(execute: PiMemoryTool['execute']): PiMemoryTool & { version: string } {
  return {
    version: '1',
    name: 'lookup',
    description: 'Read an isolated synthetic test value.',
    parameters: Type.Object(
      { group: Type.Union([Type.Literal('empty'), Type.Literal('one')]) },
      { additionalProperties: false },
    ),
    validate: () => true,
    execute,
    publicMetadata: { isDemo: true, displayLabel: 'Synthetic fixture' },
    projectInput: (args) => `Group: ${String(args.group)}`,
  };
}
const create = (options: Partial<Parameters<typeof createPiMemorySession>[0]> = {}) =>
  createPiMemorySession({
    config,
    context,
    resolveIdentity: async () => ({ platformSubjectRef: 'test-subject' }),
    ...options,
  });

test('固定 Pi 1.3.0 宿主预加载 Skill 全文，工具结果进入下一轮；普通问答不被强制调用', async () => {
  const skill =
    'For fixture requests call lookup first, then cite the actual tool value as synthetic data. For ordinary greetings answer directly.';
  const metadata = { isDemo: true, displayLabel: 'Synthetic fixture' };
  const tool = {
    ...lookup(async () => ({
      content: '{"synthetic":true,"items":[],"count":0}',
      summary: 'Synthetic data: 0 items',
    })),
    publicMetadata: metadata,
  };
  const bundle = freezePiResources({
    id: 'test',
    version: '1',
    systemPrompt: resource('prompt', 'Use only supplied tools.'),
    skills: [resource('fixture-skill', skill)],
    assets: [resource('fixture-data', '{"items":[]}')],
    tools: [tool],
  });
  metadata.displayLabel = 'MUTATED';
  let calls = 0;
  const lifecycles: PiToolLifecycle[] = [];
  const authorized: string[] = [];
  const session = await create({
    resources: bundle,
    barriers: {
      beforeModel: async (_state, request) => {
        authorized.push(request!.modelRequestId);
      },
      beforeTool: async (state, _name, call) => {
        assert.equal(call!.modelRequestId, authorized[0]);
        assert.ok(state.entries.some((entry) => entry.id === call!.sourceNativeEntryId));
      },
      onToolLifecycle: async (event) => {
        lifecycles.push(structuredClone(event));
      },
    },
    fetch: async (_input, init) => {
      calls += 1;
      assert.equal(new Headers(init?.headers).get('x-agent-model-request-id'), authorized.at(-1));
      const payload = JSON.parse(String(init?.body));
      assert.ok(JSON.stringify(payload.messages).includes(skill));
      assert.ok(!JSON.stringify(payload.messages).includes('"items":[]'));
      const messages = payload.messages as { role: string; content: string }[];
      if (calls === 1) return response(init, toolCall());
      if (calls === 2) {
        assert.ok(
          messages.some(
            (message) => message.role === 'tool' && message.content.includes('"count":0'),
          ),
        );
        return response(init, answer('Synthetic data: 0 items.'));
      }
      return response(init, answer('Hello.'));
    },
  });
  try {
    const result = await session.prompt('Read the fixture.');
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.text, 'Synthetic data: 0 items.');
    assert.equal(result.observations[0]!.modelRequestId, authorized[0]);
    assert.deepEqual(
      lifecycles.map((event) => event.status),
      ['running', 'succeeded'],
    );
    assert.equal(lifecycles[0]!.displayLabel, 'Synthetic fixture');
    assert.equal(lifecycles[1]!.resultSummary, 'Synthetic data: 0 items');
    assert.ok(lifecycles[1]!.resultNativeEntryId);
    assert.equal(lifecycles[1]!.modelRequestId, authorized[0]);
    assert.ok(!JSON.stringify(lifecycles).includes('"count":0'));
    const native = session.captureNativeState();
    assert.ok(
      native.entries.some(
        (entry) => entry.type === 'custom' && entry.customType === 'tyde.execution.resources',
      ),
    );
    assert.equal(bundle.manifest.resources.at(-1)!.kind, 'asset');
    assert.equal((await session.prompt('Hello.')).text, 'Hello.');
    assert.equal(calls, 3);
    assert.equal(lifecycles.length, 2);
  } finally {
    session.dispose();
  }
});

test('可信资源缺失、摘要异常、配置混用及开放 schema 均清晰拒绝', async () => {
  const prompt = resource('prompt', 'Trusted text.');
  assert.throws(
    () => freezePiResources({ id: 'test', version: '1', systemPrompt: { ...prompt, body: '' } }),
    /PI_RESOURCE_MISSING_OR_INVALID/,
  );
  assert.throws(
    () =>
      freezePiResources({
        id: 'test',
        version: '1',
        systemPrompt: { ...prompt, sha256: '0'.repeat(64) },
      }),
    /PI_RESOURCE_DIGEST_MISMATCH/,
  );
  assert.throws(
    () =>
      freezePiResources({
        id: 'test',
        version: '1',
        systemPrompt: prompt,
        assets: [{ ...resource('asset', '{}'), sha256: 'f'.repeat(64) }],
      }),
    /PI_RESOURCE_DIGEST_MISMATCH/,
  );
  const bundle = freezePiResources({ id: 'test', version: '1', systemPrompt: prompt });
  await assert.rejects(
    create({ resources: bundle, systemPrompt: 'unfrozen' }),
    /PI_RESOURCE_CONFIGURATION_CONFLICT/,
  );
  await assert.rejects(
    create({
      tools: [{ ...lookup(async () => 'x'), parameters: Type.Object({ value: Type.String() }) }],
    }),
    /PI_INVALID_TOOL_ALLOWLIST/,
  );
});

for (const args of ['{"group":"empty","extra":1}', '{"group":42}', '{"group":"invalid"}']) {
  test(`完整 schema 拒绝非法原始工具参数 ${args}，不授权或执行假工具过程`, async () => {
    let executions = 0;
    let authorizations = 0;
    const session = await create({
      tools: [
        lookup(async () => {
          executions += 1;
          return 'x';
        }),
      ],
      barriers: {
        beforeTool: async () => {
          authorizations += 1;
        },
      },
      fetch: async (_input, init) => response(init, toolCall('call-invalid', args)),
    });
    try {
      const result = await session.prompt('Read.');
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'MAAS_TOOL_ARGUMENTS_INVALID');
      assert.equal(executions, 0);
      assert.equal(authorizations, 0);
    } finally {
      session.dispose();
    }
  });
}

test('可等待原生工具结果保存屏障完成前，不派发下一轮模型', async () => {
  let release!: () => void;
  let reached!: () => void;
  const reachedSave = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const save = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const session = await create({
    tools: [lookup(async () => ({ content: 'actual-value', summary: 'Safe completed summary' }))],
    barriers: {
      afterTool: async (state, call) => {
        assert.equal(call!.toolCallId, 'call-w4-one');
        assert.ok(
          state.entries.some(
            (entry) => entry.type === 'message' && entry.message.role === 'toolResult',
          ),
        );
        reached();
        await save;
      },
    },
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, calls === 1 ? toolCall() : answer());
    },
  });
  try {
    const pending = session.prompt('Read.');
    await reachedSave;
    assert.equal(calls, 1);
    release();
    assert.equal((await pending).status, 'completed');
    assert.equal(calls, 2);
  } finally {
    release();
    session.dispose();
  }
});

test('工具执行异常失败关闭、保留原生关联及安全失败投影，不恢复会话', async () => {
  const events: PiToolLifecycle[] = [];
  let calls = 0;
  const session = await create({
    tools: [
      lookup(async () => {
        throw new Error('private tool failure');
      }),
    ],
    barriers: {
      onToolLifecycle: async (event) => {
        events.push(event);
      },
    },
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, toolCall());
    },
  });
  try {
    const result = await session.prompt('Read.');
    assert.equal(result.error?.code, 'PI_TOOL_FAILED');
    assert.equal(calls, 1);
    assert.deepEqual(
      events.map((event) => event.status),
      ['running', 'failed'],
    );
    assert.equal(events[1]!.errorCode, 'tool_failed');
    assert.ok(events[1]!.resultNativeEntryId);
    assert.ok(!JSON.stringify(session.captureNativeState()).includes('private tool failure'));
    await assert.rejects(session.prompt('Again.'), /PI_SESSION_BLOCKED/);
  } finally {
    session.dispose();
  }
});

test('工具中停止传播 AbortSignal，非协作工具的迟到结果不触发下一模型', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: (value: string) => void;
  const late = new Promise<string>((resolve) => {
    release = resolve;
  });
  let toolSignal: AbortSignal | undefined;
  let calls = 0;
  const events: PiToolLifecycle[] = [];
  const session = await create({
    tools: [
      lookup(async (_args, toolContext) => {
        toolSignal = toolContext.signal;
        entered();
        return late;
      }),
    ],
    barriers: {
      onToolLifecycle: async (event) => {
        events.push(event);
      },
    },
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, toolCall());
    },
  });
  try {
    const pending = session.prompt('Read.');
    await started;
    await session.stop();
    assert.equal((await pending).status, 'stopped');
    assert.equal(toolSignal!.aborted, true);
    assert.deepEqual(
      events.map((event) => event.status),
      ['running', 'cancelled'],
    );
    const before = session.captureNativeState();
    release('private late result');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.deepEqual(session.captureNativeState(), before);
  } finally {
    release('late');
    session.dispose();
  }
});

test('工具非协作执行受固定超时约束，失败不进入下一模型', async () => {
  let signal: AbortSignal | undefined;
  const events: PiToolLifecycle[] = [];
  const session = await create({
    tools: [
      {
        ...lookup(async (_args, toolContext) => {
          signal = toolContext.signal;
          return new Promise(() => {});
        }),
        timeoutMs: 15,
      },
    ],
    barriers: {
      onToolLifecycle: async (event) => {
        events.push(event);
      },
    },
    fetch: async (_input, init) => response(init, toolCall()),
  });
  try {
    const result = await session.prompt('Read.');
    assert.equal(result.error?.code, 'PI_TOOL_TIMEOUT');
    assert.equal(signal!.aborted, true);
    assert.equal(events.at(-1)!.errorCode, 'timeout');
  } finally {
    session.dispose();
  }
});

test('同一真实 tool_call_id 的重复模型回调不重复执行', async () => {
  let executions = 0;
  let calls = 0;
  const session = await create({
    tools: [
      lookup(async () => {
        executions += 1;
        return 'actual';
      }),
    ],
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, toolCall('same-real-call-id'));
    },
  });
  try {
    const result = await session.prompt('Read.');
    assert.equal(result.status, 'failed');
    assert.equal(executions, 1);
    assert.equal(calls, 2);
    assert.equal(result.error?.code, 'PI_TOOL_DUPLICATE_CALL');
  } finally {
    session.dispose();
  }
});

test('工具启动投影等待中停止，授权不会越过停止直接执行', async () => {
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const save = new Promise<void>((resolve) => {
    release = resolve;
  });
  let executions = 0;
  const events: PiToolLifecycle[] = [];
  const session = await create({
    tools: [
      lookup(async () => {
        executions += 1;
        return 'actual';
      }),
    ],
    barriers: {
      onToolLifecycle: async (event) => {
        events.push(event);
        if (event.status === 'running') {
          reached();
          await save;
        }
      },
    },
    fetch: async (_input, init) => response(init, toolCall()),
  });
  try {
    const pending = session.prompt('Read.');
    await waiting;
    await session.stop();
    assert.equal((await pending).status, 'stopped');
    assert.equal(executions, 0);
    assert.deepEqual(
      events.map((event) => event.status),
      ['running', 'cancelled'],
    );
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executions, 0);
  } finally {
    release();
    session.dispose();
  }
});

for (const exceed of ['none', 'model', 'tool'] as const) {
  test(`真实Pi循环按Attempt累计模型/工具授权，最后额度允许完成：${exceed}`, async () => {
    const budget = new AttemptBudget({
      limits: {
        policy_version: 1,
        max_duration_ms: 5000,
        max_model_requests: exceed === 'model' ? 1 : 2,
        max_tool_calls: 1,
      },
    });
    budget.start();
    let calls = 0;
    let executions = 0;
    const session = await create({
      tools: [
        lookup(async () => {
          executions += 1;
          return 'actual';
        }),
      ],
      barriers: {
        beforeModel: async (_state, request) => {
          assert.equal(budget.authorizeModel(request!.modelRequestId), true);
        },
        beforeModelDispatch: async () => {
          budget.assertCanProceed();
        },
        beforeTool: async (_state, _name, call) => {
          assert.equal(budget.authorizeTool(call!.toolCallId), true);
        },
        beforeToolDispatch: async () => {
          budget.assertCanProceed();
        },
        executionSignal: () => budget.signal,
        executionRemainingMs: () => budget.remainingMs(),
      },
      fetch: async (_input, init) => {
        calls += 1;
        return response(
          init,
          calls === 1 || exceed === 'tool' ? toolCall(`call-${calls}`) : answer(),
        );
      },
    });
    try {
      const result = await session.prompt('Read.');
      assert.equal(result.status, exceed === 'none' ? 'completed' : 'failed');
      assert.equal(executions, 1);
      assert.equal(calls, exceed === 'model' ? 1 : 2);
      assert.equal(budget.view().tool_calls_used, 1);
      assert.equal(budget.view().model_requests_used, exceed === 'model' ? 1 : 2);
      assert.equal(
        budget.limitError?.code ?? null,
        exceed === 'none'
          ? null
          : exceed === 'model'
            ? 'ATTEMPT_MODEL_REQUEST_LIMIT_EXCEEDED'
            : 'ATTEMPT_TOOL_CALL_LIMIT_EXCEEDED',
      );
      if (exceed === 'none') budget.complete();
    } finally {
      budget.finish();
      session.dispose();
    }
  });
}

test('执行中deadline撤销工具信号，预算失败保留真实计数且不收取迟到结果', async () => {
  const events: PiToolLifecycle[] = [];
  const budget = new AttemptBudget({
    limits: { policy_version: 1, max_duration_ms: 100, max_model_requests: 2, max_tool_calls: 1 },
  });
  budget.start();
  let calls = 0;
  const session = await create({
    tools: [{ ...lookup(async () => new Promise(() => {})), timeoutMs: 5000 }],
    barriers: {
      beforeModel: async (_state, request) => {
        budget.authorizeModel(request!.modelRequestId);
      },
      beforeTool: async (_state, _name, call) => {
        budget.authorizeTool(call!.toolCallId);
      },
      beforeModelDispatch: async () => {
        budget.assertCanProceed();
      },
      beforeToolDispatch: async () => {
        budget.assertCanProceed();
      },
      executionSignal: () => budget.signal,
      executionRemainingMs: () => budget.remainingMs(),
      onToolLifecycle: async (event) => {
        events.push(event);
      },
    },
    fetch: async (_input, init) => {
      calls += 1;
      return response(init, toolCall());
    },
  });
  try {
    const result = await session.prompt('Read.');
    assert.equal(result.status, 'failed');
    assert.equal(budget.limitError?.code, 'ATTEMPT_DURATION_LIMIT_EXCEEDED');
    assert.equal(budget.view().model_requests_used, 1);
    assert.equal(budget.view().tool_calls_used, 1);
    assert.equal(calls, 1);
    assert.equal(events.at(-1)!.errorCode, 'budget_exceeded');
  } finally {
    budget.finish();
    session.dispose();
  }
});
