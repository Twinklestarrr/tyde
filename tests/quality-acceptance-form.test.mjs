import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualityContextResponse } from '../apps/server/src/modules/production/quality-acceptance.schema.ts';
import { taskExample } from '../apps/server/src/modules/production/production.schema.ts';
import {
  acceptanceInput,
  acceptanceDefaultQuantity,
  validateAcceptanceContext,
  acceptanceReviewInput,
  acceptanceReviewSnapshotMatches,
  acceptanceSnapshotConfirmed,
  productionBodyBytes,
  productionDateRange,
  qualityInput,
} from '../apps/web/src/modules/projects/quality-acceptance-form.ts';

const context = qualityContextResponse.examples[0];
const key = { projectId: 1, memberId: 1, reportDate: '2026-10-26' };
const draft = {
  id: 'draft',
  outputReportId: 1,
  inspected: '9.5000',
  qualified: '9',
  reason: ' 原因 ',
};
const now = new Date('2026-11-03T16:01:00Z');
const form = { quantity: '10', date: '2026-11-04', remark: ' 保留用户说明 ' };
const baseline = taskExample.records[0];

test('NAV review sends only the decision for the selected task and requires a bounded rejection reason', () => {
  assert.deepEqual(acceptanceReviewInput(1, 5, 'ACCEPT', '不会用于通过的旧驳回原因'), {
    projectId: 1,
    subtaskId: 5,
    decision: 'ACCEPT',
  });
  assert.deepEqual(acceptanceReviewInput(1, 5, 'REJECT', '  请修正交付内容  '), {
    projectId: 1,
    subtaskId: 5,
    decision: 'REJECT',
    rejectReason: '请修正交付内容',
  });
  assert.throws(() => acceptanceReviewInput(1, 5, 'REJECT', '  '), /驳回原因/);
  assert.equal(acceptanceReviewInput(1, 5, 'REJECT', '核'.repeat(500)).rejectReason.length, 500);
  assert.throws(() => acceptanceReviewInput(1, 5, 'REJECT', '核'.repeat(501)), /500/);
});

test('NAV review refuses a changed submission, task source, quantity snapshot or status before POST', () => {
  assert.equal(acceptanceReviewSnapshotMatches(baseline, structuredClone(baseline)), true);
  for (const patch of [
    { subtaskId: baseline.subtaskId + 1 },
    { status: 'ACCEPTED' },
    { submittedAt: '2026-11-04 18:00:00' },
    { actualQuantity: 987.5 },
    { actualDeliveryDate: '2026-11-05' },
    { reportedQuantity: 888 },
    { quantityAdjustmentRemark: '新一轮说明' },
    { quantityUnit: '批次' },
    { reviewedAt: '2026-11-04 18:10:00' },
    { rejectReason: '其他审核原因' },
  ])
    assert.equal(acceptanceReviewSnapshotMatches(baseline, { ...baseline, ...patch }), false);
});

test('quality keeps legacy quantity bounds, required failure reason and one item per report', () => {
  const result = qualityInput(key, [draft], context);
  assert.equal(result.items[0].inspectedQuantity, '9.5');
  assert.equal(result.items[0].unqualifiedReason, '原因');
  assert.throws(
    () => qualityInput(key, [draft, { ...draft, id: 'again' }], context),
    /只能录入一条/,
  );
  assert.throws(() => qualityInput(key, [{ ...draft, inspected: '10.0001' }], context), /不能超过/);
  assert.throws(() => qualityInput(key, [draft], context, 9), /不能超过/);
  assert.throws(() => qualityInput(key, [{ ...draft, reason: ' ' }], context), /不合格数据原因/);
  assert.equal(
    qualityInput(key, [{ ...draft, qualified: '9.5' }], context).items[0].unqualifiedReason,
    null,
  );
  assert.throws(
    () =>
      qualityInput(key, [draft], { ...context, items: [{ ...context.items[0], quantity: 1e20 }] }),
    /精确核对范围/,
  );
});

test('acceptance restores exact defaults and requires adjustment remarks before POST', () => {
  assert.equal(acceptanceDefaultQuantity(123.4567), '123.4567');
  assert.equal(acceptanceDefaultQuantity(2 ** 39), '');
  const context = { canSubmit: true, pendingCount: 0, returnedCount: 0, reportedQuantity: 10 };
  assert.doesNotThrow(() =>
    validateAcceptanceContext({ ...form, quantity: '10.0000', remark: '' }, context),
  );
  assert.throws(
    () => validateAcceptanceContext({ ...form, quantity: '11', remark: '' }, context),
    /数量调整说明/,
  );
  assert.throws(
    () => validateAcceptanceContext(form, { ...context, pendingCount: 1 }),
    /核查或修正/,
  );
});

test('quality requires a fresh editable report in the same member/date context', () => {
  assert.throws(() => qualityInput(key, [draft], { ...context, memberId: 2 }), /成员或生产日期/);
  assert.throws(
    () => qualityInput(key, [draft], { ...context, reportDate: '2026-10-27' }),
    /成员或生产日期/,
  );
  assert.throws(() => qualityInput(key, [draft], { ...context, items: [] }), /不可追加/);
  assert.throws(
    () =>
      qualityInput(key, [draft], {
        ...context,
        items: [{ ...context.items[0], editable: false, qualityDataSource: 'WORK_SYSTEM' }],
      }),
    /不可追加/,
  );
  assert.throws(
    () =>
      qualityInput(key, [draft], {
        ...context,
        items: [context.items[0], { ...context.items[0], qualityId: 2, editable: false }],
      }),
    /不可追加/,
  );
  assert.throws(() => qualityInput(key, [{ ...draft, inspected: '0' }], context), /数量须/);
  assert.throws(() => qualityInput(key, [{ ...draft, qualified: '10.5001' }], context), /合格数量/);
  assert.throws(
    () => qualityInput(key, [{ ...draft, reason: '字'.repeat(1001) }], context),
    /1000字/,
  );
  assert.throws(
    () =>
      qualityInput(
        key,
        Array.from({ length: 101 }, () => draft),
        context,
      ),
    /1至100/,
  );
});

test('quality request limit counts exact UTF-8 bytes at 512 KiB', () => {
  const limit = 512 * 1024;
  const available = limit - Buffer.byteLength(JSON.stringify({ text: '' }));
  const text = '字'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
  assert.equal(Buffer.byteLength(JSON.stringify({ text })), limit);
  assert.equal(productionBodyBytes({ text }).text, text);
  assert.throws(() => productionBodyBytes({ text: `${text}x` }), /512 KiB/);
});

test('acceptance submits exact strings and preserves remarks without reverse-engineering rounded totals', () => {
  const quantity = `${'9'.repeat(26)}.9999`;
  assert.deepEqual(acceptanceInput(1, 1, { ...form, quantity }, now), {
    projectId: 1,
    subtaskId: 1,
    actualQuantity: quantity,
    actualDeliveryDate: '2026-11-04',
    quantityAdjustmentRemark: '保留用户说明',
  });
  assert.equal(acceptanceInput(1, 1, { ...form, remark: '' }, now).quantityAdjustmentRemark, null);
  assert.throws(() => acceptanceInput(1, 1, { ...form, date: '2026-11-03' }, now), /实际交付日期/);
  assert.throws(() => acceptanceInput(1, 1, { ...form, date: '2027-02-29' }, now), /实际交付日期/);
  assert.throws(() => acceptanceInput(1, 1, { ...form, quantity: '0' }, now), /数量须/);
  assert.throws(() => acceptanceInput(1, 1, { ...form, remark: '字'.repeat(1001) }, now), /1000字/);
});

test('unknown acceptance needs a new submitted snapshot of the same subtask and exact visible quantity', () => {
  const input = acceptanceInput(1, 1, form, now);
  const current = {
    ...baseline,
    status: 'PENDING_ACCEPTANCE',
    actualQuantity: 10,
    reportedQuantity: 8,
    actualDeliveryDate: form.date,
    quantityAdjustmentRemark: '保留用户说明',
    submittedAt: '2026-11-04 00:02:00',
  };
  assert.equal(acceptanceSnapshotConfirmed(input, baseline, current), true);
  assert.equal(
    acceptanceSnapshotConfirmed(input, baseline, { ...current, status: 'ACCEPTED' }),
    true,
  );
  assert.equal(
    acceptanceSnapshotConfirmed(input, baseline, {
      ...current,
      quantityAdjustmentRemark: null,
      reportedQuantity: 10,
    }),
    true,
  );
  for (const change of [
    { subtaskId: 2 },
    { submittedAt: null },
    { actualQuantity: 11 },
    { actualDeliveryDate: '2026-11-05' },
    { quantityAdjustmentRemark: '其他原因' },
    { status: 'IN_PROGRESS' },
  ])
    assert.equal(acceptanceSnapshotConfirmed(input, baseline, { ...current, ...change }), false);
  assert.equal(acceptanceSnapshotConfirmed(input, current, current), false);
  const large = acceptanceInput(1, 1, { ...form, quantity: '9007199254740992' }, now);
  assert.equal(
    acceptanceSnapshotConfirmed(large, baseline, { ...current, actualQuantity: 9007199254740992 }),
    false,
  );
});

test('daily production filters support at most 31 inclusive calendar days', () => {
  assert.deepEqual(productionDateRange('2026-10-01', '2026-10-31'), {
    reportDateStart: '2026-10-01',
    reportDateEnd: '2026-10-31',
  });
  assert.throws(() => productionDateRange('2026-10-01', '2026-11-01'), /1至31天/);
  assert.throws(() => productionDateRange('2026-10-02', '2026-10-01'), /1至31天/);
  assert.throws(() => productionDateRange('2026-02-30', '2026-03-01'), /有效的生产日期/);
});
