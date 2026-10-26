import { SessionManager } from '@earendil-works/pi-coding-agent';

const usage = {
  input: 3,
  output: 4,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 8,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Every entry here is produced by the actual fixed SDK, not a product-message converter. */
export function nativeSample() {
  const manager = SessionManager.inMemory('/isolated/native-fixture');
  manager.appendModelChange('openai-compatible', 'isolated-model');
  manager.appendThinkingLevelChange('off');
  manager.appendMessage({
    role: 'system',
    content: [{ type: 'text', text: 'Only use the explicitly supplied read-only fixture.' }],
    sections: { host: 'isolated', removed: null },
    toolsAdded: [],
    timestamp: 1,
  });
  const input = manager.appendMessage({ role: 'user', content: 'remember amber', timestamp: 2 });
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Use the isolated fixture', thinkingSignature: 'opaque' },
      { type: 'toolCall', id: 'call-fixture', name: 'readonly_fixture', arguments: { value: 0 } },
    ],
    api: 'openai-completions',
    provider: 'openai-compatible',
    model: 'isolated-model',
    usage,
    stopReason: 'toolUse',
    responseId: 'response-fixture',
    timestamp: 3,
  });
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call-fixture',
    toolName: 'readonly_fixture',
    content: [{ type: 'text', text: 'amber' }],
    details: { array: [false, null, 0, { preserved: true }] },
    isError: false,
    timestamp: 4,
  });
  manager.appendCustomEntry('isolated.state', { nested: { zero: 0 }, custom: ['a', null] });
  manager.appendCustomMessageEntry('isolated.context', 'fixture context', false, {
    private: false,
  });
  manager.appendContextEdit(input, { content: 'remember amber, edited' });
  manager.appendUsage('fixture', 'openai-compatible', 'isolated-model', usage, 'native usage');
  manager.appendLabelChange(input, 'before-branch');
  manager.appendSessionInfo('Native fixture');
  manager.appendCompaction('native summary', null, 20, { marker: 'compacted' }, true, usage);
  manager.branch(input);
  manager.branchWithSummary(input, 'abandoned fixture branch', { preserved: true }, true, usage);
  manager.resetLeaf();
  manager.appendCustomEntry('isolated.second-root', { root: 2 });
  manager.branch(input);
  return { manager, input };
}
