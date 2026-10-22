import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { validateAgentContract } from '@tyde/shared/agent';

/** v1 的摘要形态属于协议；升级时保留旧规则，不能用新的默认值解释旧请求。 */
export function prepareCommand(conversationId: string, request: unknown) {
  if (!validateAgentContract('UUID', conversationId)) {
    throw new Error('INVALID_REQUEST: conversation_id 必须是 UUID');
  }
  if (!validateAgentContract('CommandRequest', request)) {
    throw new Error('INVALID_REQUEST: 命令不符合 v1 契约');
  }

  const identity = {
    requestKey: request.request_key.toLowerCase(),
    clientInstanceId: request.client_instance_id?.toLowerCase(),
  };
  const common = {
    api_major_version: 1,
    schema_version: request.schema_version,
    conversation_id: conversationId.toLowerCase(),
    kind: request.kind,
  };
  const input =
    'input' in request
      ? { text: request.input.text, context: structuredClone(request.input.context ?? {}) }
      : undefined;
  // 明确选取参与摘要的字段，令牌、key 与客户端实例都不进入原意图摘要。
  const semanticPayload =
    request.kind === 'start_task'
      ? { ...common, task_kind: request.task_kind, input }
      : {
          ...common,
          task_id: request.task_id.toLowerCase(),
          target_attempt_id: request.target_attempt_id.toLowerCase(),
          ...(request.kind === 'stop_attempt'
            ? {}
            : { expected_task_version: request.expected_task_version }),
          ...(input ? { input } : {}),
        };
  const canonicalPayload = canonicalize(semanticPayload);
  if (canonicalPayload === undefined) throw new Error('INVALID_REQUEST: 无法规范化命令');
  freezeSemanticPayload(semanticPayload);

  return Object.freeze({
    ...identity,
    semanticPayload,
    canonicalPayload,
    payloadHash: createHash('sha256').update(canonicalPayload, 'utf8').digest('hex'),
  });
}

function freezeSemanticPayload(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const entry of Object.values(value)) freezeSemanticPayload(entry);
  Object.freeze(value);
}
