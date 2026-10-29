import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectCreateInput,
  projectCreateValues,
  validateProjectCreate,
} from '../apps/web/src/modules/projects/project-create-form.ts';

test('date-only drafts preserve the Shanghai calendar date and submit its end of day', () => {
  const blank = projectCreateValues(null);
  assert.equal(blank.deadline, '');
  assert.equal(projectCreateInput(blank).deadline, null);
  for (const deadline of ['2099-12-31 18:20:30', '2099-12-31 00:00:00']) {
    const values = projectCreateValues({ deadline });
    assert.equal(values.deadline, '2099-12-31');
    assert.equal(projectCreateInput(values).deadline, '2099-12-31 23:59:59');
  }
});

test('date-only validation rejects impossible dates and keeps the draft creation boundary', () => {
  const blank = projectCreateValues(null);
  const errors = (deadline, createdAt = '2028-02-28 12:00:00') =>
    validateProjectCreate({ ...blank, deadline }, false, createdAt);
  assert.equal(errors('2028-02-29').deadline, undefined);
  assert.equal(errors('2027-02-29').deadline, '请填写有效的截止日期');
  assert.equal(errors('2028-02-30').deadline, '请填写有效的截止日期');
  assert.equal(errors('2028-02-29T18:20:30').deadline, '请填写有效的截止日期');
  assert.equal(errors('2028-02-28', '2028-02-28 23:59:58').deadline, undefined);
  assert.equal(errors('2028-02-28', '2028-02-28 23:59:59').deadline, '截止日期须晚于草稿创建时间');
  assert.equal(errors('2028-02-27').deadline, '截止日期须晚于草稿创建时间');
});
