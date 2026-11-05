import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../packages/shared/dist/index.js';
import {
  productionQuantity,
  productionFailureIsUnknown,
  productionQuantityUnits,
  productionTaskInput,
  productionReviewInput,
} from '../apps/web/src/modules/projects/production-task-form.ts';

test('production writes keep timeouts, business failures and session boundaries unknown', () => {
  for (const status of [0, 200, 202, 204, 408, 500, 502, 504])
    assert.equal(
      productionFailureIsUnknown(new ApiError(status, { code: 409, message: '结果不确定' })),
      true,
    );
  for (const status of [400, 401, 403, 404, 409, 413, 422, 429])
    assert.equal(
      productionFailureIsUnknown(new ApiError(status, { code: 'REJECTED', message: '明确拒绝' })),
      false,
    );
  for (const code of ['SESSION_CHANGED', 'INVALID_RESPONSE'])
    assert.equal(
      productionFailureIsUnknown(new ApiError(409, { code, message: '结果不确定' })),
      true,
    );
  assert.equal(productionFailureIsUnknown(new Error('断网')), true);
});

test('production decimals remain exact strings across the full 26+4 range without Number rounding', () => {
  const largest = '99999999999999999999999999.9999';
  assert.equal(productionQuantity(largest), largest);
  assert.equal(productionQuantityUnits(largest), 999999999999999999999999999999n);
  assert.equal(productionQuantity(' +00001.230000 '), '1.23');
  assert.equal(productionQuantity('.0001'), '0.0001');
  assert.equal(productionQuantity('0', true), '0');
  for (const value of ['0', '-1', '1e10', '100000000000000000000000000', '1.00001', 'NaN', ''])
    assert.throws(() => productionQuantity(value), /数量/);
});
test('task creation uses Shanghai dates, designated member IDs and an empty pool with no phantom assignment', () => {
  const now = new Date('2026-11-03T16:00:00Z');
  const draft = {
    name: ' 首批生产 ',
    quantity: '9007199254740993.1234',
    date: '2026-11-04',
    mode: 'DESIGNATED',
    memberIds: [2, 1, 2],
  };
  assert.deepEqual(productionTaskInput(1, draft, now), {
    projectId: 1,
    subtaskName: '首批生产',
    expectedQuantity: '9007199254740993.1234',
    expectedDeliveryDate: '2026-11-04',
    distributionMode: 'DESIGNATED',
    memberIds: [2, 1],
  });
  assert.deepEqual(productionTaskInput(1, { ...draft, mode: 'POOL' }, now).memberIds, []);
  assert.throws(() => productionTaskInput(1, { ...draft, memberIds: [] }, now), /至少选择/);
  assert.throws(() => productionTaskInput(1, { ...draft, date: '2026-11-03' }, now), /上海当天/);
  assert.throws(() => productionTaskInput(1, { ...draft, date: '2027-02-29' }, now), /有效日期/);
  assert.throws(
    () =>
      productionTaskInput(
        1,
        { ...draft, memberIds: Array.from({ length: 1001 }, (_, i) => i + 1) },
        now,
      ),
    /1000/,
  );
});
test('empty selected review never silently becomes all-scope verification; returns preserve one source and reason', () => {
  assert.throws(() => productionReviewInput(1, 7, 'SELECTED', [], ''), /不会自动改为全部/);
  assert.deepEqual(productionReviewInput(1, 7, 'ALL', [3], ''), {
    projectId: 1,
    subtaskId: 7,
    action: 'VERIFY',
    reportIds: [],
  });
  assert.deepEqual(productionReviewInput(1, null, 'RETURN', [3], ' 重新核对 '), {
    projectId: 1,
    subtaskId: null,
    action: 'RETURN',
    reportIds: [3],
    reason: '重新核对',
  });
  assert.throws(() => productionReviewInput(1, 7, 'RETURN', [1, 2], '原因'), /1条/);
  assert.throws(() => productionReviewInput(1, 7, 'RETURN', [1], ' '), /原因/);
});
