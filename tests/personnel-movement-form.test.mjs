import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movementItemExample } from '../apps/server/src/modules/personnel/personnel-movement-query.schema.ts';
import {
  personnelMovementCreateInput,
  personnelMovementApprovalStep,
  personnelMovementDateFilters,
  personnelMovementProcessConfirmed,
  personnelMovementProcessInput,
} from '../apps/web/src/modules/projects/personnel-movement-form.ts';

const now = new Date('2026-11-03T16:01:00Z');
const form = {
  movementType: 'REMOVAL',
  reason: ' 项目安排调整 ',
  plannedEffectiveDate: '2026-11-04',
  targetProjectId: '',
};
const userId = '00000000-0000-4000-8000-000000000003';
const approval = {
  ...movementItemExample,
  movementType: 'TRANSFER',
  status: 'PROCESSING',
  sourceProjectId: 1,
  targetProjectId: 2,
  flowNo: 'TF1',
  flowStatus: 'PENDING',
  flowVersionNo: 3,
  actionableNodeId: null,
  currentNode: 4,
  allowedActions: ['APPROVE', 'REJECT'],
  approvalSteps: [
    {
      nodeId: userId,
      nodeSeq: 4,
      nodeCode: 'TARGET_MANAGER',
      nodeName: '目标主策略官',
      nodeStatus: 'PENDING',
      operatorId: null,
      operatorName: null,
      action: null,
      actionComment: null,
      actionAt: null,
      nodeVersionNo: 2,
    },
  ],
};

test('movement creation uses member IDs, deduplicates a whole batch and enforces Shanghai date', () => {
  assert.deepEqual(personnelMovementCreateInput(1, [3, 2, 3], form, now), {
    projectId: 1,
    memberIds: [2, 3],
    movementType: 'REMOVAL',
    reason: '项目安排调整',
    plannedEffectiveDate: '2026-11-04',
  });
  for (const plannedEffectiveDate of ['2026-11-03', '2027-02-29', '2026-02-30', '0000-01-01'])
    assert.throws(
      () => personnelMovementCreateInput(1, [2], { ...form, plannedEffectiveDate }, now),
      /生效日期/,
    );
  assert.throws(() => personnelMovementCreateInput(1, [], form, now), /1至100/);
  assert.throws(
    () =>
      personnelMovementCreateInput(
        1,
        Array.from({ length: 101 }, (_, i) => i + 1),
        form,
        now,
      ),
    /1至100/,
  );
  assert.throws(() => personnelMovementCreateInput(1, [2147483648], form, now), /1至100/);
  assert.throws(() => personnelMovementCreateInput(1, [2], { ...form, reason: ' ' }, now), /原因/);
  assert.throws(
    () => personnelMovementCreateInput(1, [2], { ...form, reason: '字'.repeat(501) }, now),
    /原因/,
  );
});

test('personal transfer accepts an explicit valid target without relying on candidate results', () => {
  const transfer = { ...form, movementType: 'TRANSFER', targetProjectId: ' 2 ' };
  assert.equal(personnelMovementCreateInput(1, [2], transfer, now).targetProjectId, 2);
  for (const targetProjectId of ['', '1', '0', '2e1', '2.5', '2147483648'])
    assert.throws(
      () => personnelMovementCreateInput(1, [2], { ...transfer, targetProjectId }, now),
      /目标项目ID/,
    );
});

test('EXPERT cannot initiate removal or transfer even when the backend accepts these commands', () => {
  assert.throws(
    () => personnelMovementCreateInput(1, [2], form, now, 'EXPERT'),
    /只能由原项目主策略官/,
  );
  assert.throws(
    () =>
      personnelMovementCreateInput(
        1,
        [2],
        { ...form, movementType: 'TRANSFER', targetProjectId: '2' },
        now,
        'EXPERT',
      ),
    /只能由原项目主策略官/,
  );
});

test('EXPERT processes only a uniquely identifiable current organization manual node', () => {
  for (const nodeCode of ['SOURCE_ORG_OWNER', 'TARGET_ORG_OWNER']) {
    const movement = { ...approval, approvalSteps: [{ ...approval.approvalSteps[0], nodeCode }] };
    const result = personnelMovementProcessInput(2, movement, 'APPROVE', '', 'EXPERT');
    assert.equal(result.nodeId, userId);
    assert.equal(result.nodeVersionNo, 2);
    assert.equal(result.flowVersionNo, 3);
    assert.throws(() => personnelMovementProcessInput(2, movement, 'APPROVE', ''), /审批节点/);
    const ambiguous = {
      ...movement,
      approvalSteps: [
        movement.approvalSteps[0],
        { ...movement.approvalSteps[0], nodeId: 'another-node', operatorId: userId },
      ],
    };
    assert.equal(personnelMovementApprovalStep(ambiguous, 'EXPERT'), null);
    assert.throws(
      () => personnelMovementProcessInput(2, ambiguous, 'APPROVE', '', 'EXPERT'),
      /审批节点/,
    );
  }
  for (const nodeCode of ['TARGET_MANAGER', 'MEMBER_CONFIRM', 'TARGET_ENTRANCE_EXAM'])
    assert.throws(
      () =>
        personnelMovementProcessInput(
          2,
          { ...approval, approvalSteps: [{ ...approval.approvalSteps[0], nodeCode }] },
          'APPROVE',
          '',
          'EXPERT',
        ),
      /审批节点/,
    );
});

test('PM approval preserves both versions and cannot act on member, exam or organization waits', () => {
  assert.deepEqual(personnelMovementProcessInput(2, approval, 'APPROVE', ''), {
    projectId: 2,
    movementId: 1,
    flowNo: 'TF1',
    nodeId: userId,
    nodeVersionNo: 2,
    flowVersionNo: 3,
    action: 'APPROVE',
  });
  assert.equal(
    personnelMovementProcessInput(2, approval, 'REJECT', ' 资料不完整 ').actionComment,
    '资料不完整',
  );
  assert.throws(() => personnelMovementProcessInput(2, approval, 'REJECT', ' '), /驳回意见/);
  assert.throws(
    () => personnelMovementProcessInput(2, { ...approval, allowedActions: [] }, 'APPROVE', ''),
    /审批节点/,
  );
  for (const nodeCode of [
    'MEMBER_CONFIRM',
    'TARGET_ENTRANCE_EXAM',
    'SOURCE_ORG_OWNER',
    'TARGET_ORG_OWNER',
  ])
    assert.throws(
      () =>
        personnelMovementProcessInput(
          2,
          { ...approval, approvalSteps: [{ ...approval.approvalSteps[0], nodeCode }] },
          'APPROVE',
          '',
        ),
      /审批节点/,
    );
  assert.throws(
    () =>
      personnelMovementProcessInput(
        2,
        { ...approval, approvalSteps: [approval.approvalSteps[0], approval.approvalSteps[0]] },
        'APPROVE',
        '',
      ),
    /审批节点/,
  );
  assert.throws(() => personnelMovementProcessInput(3, approval, 'APPROVE', ''), /审批节点/);
});

test('server actionable node selects the current user in a parallel organization approval group', () => {
  const first = {
    ...approval.approvalSteps[0],
    nodeId: 'first-node',
    nodeCode: 'TARGET_ORG_OWNER',
    nodeVersionNo: 4,
  };
  const own = { ...first, nodeId: 'own-node', nodeVersionNo: 7, operatorId: null };
  const movement = { ...approval, actionableNodeId: own.nodeId, approvalSteps: [first, own] };
  assert.equal(personnelMovementApprovalStep(movement, 'EXPERT'), own);
  const input = personnelMovementProcessInput(2, movement, 'APPROVE', '确认', 'EXPERT');
  assert.equal(input.nodeId, 'own-node');
  assert.equal(input.nodeVersionNo, 7);
  assert.equal(input.flowVersionNo, 3);
  for (const actionableNodeId of [undefined, null])
    assert.equal(personnelMovementApprovalStep({ ...movement, actionableNodeId }, 'EXPERT'), null);
});

test('invalid actionable node never falls back to another unique pending node', () => {
  const own = {
    ...approval.approvalSteps[0],
    nodeId: 'own-node',
    nodeCode: 'SOURCE_ORG_OWNER',
    operatorId: userId,
  };
  for (const changed of [
    { actionableNodeId: 'missing-node' },
    { approvalSteps: [{ ...own, nodeSeq: approval.currentNode - 1 }] },
    { approvalSteps: [{ ...own, nodeCode: 'TARGET_MANAGER' }] },
    { approvalSteps: [{ ...own, nodeStatus: 'APPROVED' }] },
  ]) {
    const movement = {
      ...approval,
      actionableNodeId: own.nodeId,
      approvalSteps: [own],
      ...changed,
    };
    assert.equal(personnelMovementApprovalStep(movement, 'EXPERT'), null);
    assert.throws(
      () => personnelMovementProcessInput(2, movement, 'APPROVE', '', 'EXPERT'),
      /审批节点/,
    );
  }
  for (const actionableNodeId of [undefined, null])
    assert.equal(
      personnelMovementApprovalStep(
        { ...approval, actionableNodeId, approvalSteps: [own] },
        'EXPERT',
      ),
      own,
    );
});

test('unknown approval is confirmed by its exact node, actor, action and comment, not aggregate status', () => {
  const input = personnelMovementProcessInput(2, approval, 'APPROVE', '同意');
  const current = {
    ...approval,
    approvalSteps: [
      {
        ...approval.approvalSteps[0],
        nodeVersionNo: 3,
        operatorId: userId,
        action: 'APPROVE',
        actionComment: '同意',
      },
    ],
  };
  assert.equal(personnelMovementProcessConfirmed(input, current, userId), true);
  assert.equal(
    personnelMovementProcessConfirmed(input, { ...current, movementId: 2 }, userId),
    false,
  );
  assert.equal(
    personnelMovementProcessConfirmed(input, { ...current, flowNo: 'TF2' }, userId),
    false,
  );
  for (const change of [
    { nodeId: 'other' },
    { nodeVersionNo: 2 },
    { operatorId: 'other' },
    { action: 'REJECT' },
    { actionComment: '其他意见' },
  ])
    assert.equal(
      personnelMovementProcessConfirmed(
        input,
        { ...current, approvalSteps: [{ ...current.approvalSteps[0], ...change }] },
        userId,
      ),
      false,
    );
  assert.equal(
    personnelMovementProcessConfirmed(input, { ...approval, status: 'WAITING_EFFECTIVE' }, userId),
    false,
  );
});

test('movement creation-date filters cover complete Shanghai days and reject inverted dates', () => {
  assert.deepEqual(personnelMovementDateFilters('2026-11-01', '2026-11-04'), {
    createdStartAt: '2026-11-01 00:00:00',
    createdEndAt: '2026-11-04 23:59:59',
  });
  assert.deepEqual(personnelMovementDateFilters('', ''), {});
  assert.throws(() => personnelMovementDateFilters('2026-11-05', '2026-11-04'), /日期范围/);
  assert.throws(() => personnelMovementDateFilters('2026-02-30', ''), /日期范围/);
});
