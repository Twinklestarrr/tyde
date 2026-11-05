import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expertTaskExample } from '../apps/server/src/modules/expert/expert-task.schema.ts';
import { reportsResponse } from '../apps/server/src/modules/production/output-report.schema.ts';
import {
  expertCorrectionInput,
  expertReportInput,
  isExpertProductionTask,
  newExpertReportDraft,
  sameExpertProductionSource,
} from '../apps/web/src/modules/projects/expert-production-form.ts';

const task = {
  ...structuredClone(expertTaskExample),
  acceptanceStatus: 'ACCEPTED',
  branchNodeCode: 'PRODUCTION_TASK',
  currentNodeCode: 'PRODUCTION_TASK',
};
const now = new Date('2026-11-03T16:00:00Z');
test('expert production keeps ordinary and transfer source identities distinct and does not borrow another task', () => {
  assert.equal(isExpertProductionTask(task), true);
  assert.equal(isExpertProductionTask({ ...task, branchNodeCode: 'STANDARD_TRAINING' }), false);
  assert.equal(
    isExpertProductionTask({
      ...task,
      branchNodeCode: 'OUTPUT_DATA_REVIEW',
      operations: { ...task.operations, canReportOutput: false },
    }),
    true,
  );
  assert.equal(isExpertProductionTask({ ...task, acceptanceStatus: 'PENDING_ACCEPTANCE' }), false);
  assert.equal(
    sameExpertProductionSource(task, {
      ...task,
      sourceBizType: 'PROJECT_MEMBER_TRANSFER',
      assignmentId: null,
      movementId: task.sourceBizId,
    }),
    false,
  );
  assert.equal(
    sameExpertProductionSource(task, {
      ...task,
      basicInfo: { ...task.basicInfo, organizationId: 'another-org' },
    }),
    false,
  );
});
test('legacy reporting forbids project-level output and member delegation', () => {
  const row = { ...newExpertReportDraft(1), date: '2026-11-04', quantity: '1' };
  assert.throws(
    () => expertReportInput(1, [{ ...row, subtaskId: null }], now),
    /请选择可报量子任务/,
  );
  assert.throws(() => expertReportInput(1, [{ ...row, memberId: 7 }], now), /不能代他人报量/);
});
test('batch reports preserve zero and exact decimal strings, omit automatic member IDs and enforce distinct member/layer/day', () => {
  const row = {
    ...newExpertReportDraft(1),
    date: '2026-11-04',
    quantity: '0',
    remark: ' 当天零量 ',
  };
  assert.deepEqual(
    expertReportInput(
      1,
      [
        row,
        {
          ...row,
          key: 'second',
          subtaskId: 2,
          quantity: '99999999999999999999999999.9999',
        },
      ],
      now,
    ),
    {
      projectId: 1,
      reports: [
        { subtaskId: 1, reportDate: '2026-11-04', quantity: '0', remark: '当天零量' },
        {
          subtaskId: 2,
          reportDate: '2026-11-04',
          quantity: '99999999999999999999999999.9999',
          remark: '当天零量',
        },
      ],
    },
  );
  assert.throws(
    () => expertReportInput(1, [row, { ...row, key: 'duplicate' }], now),
    /不能.*重复报量/,
  );
  assert.throws(
    () => expertReportInput(1, [{ ...row, date: '2026-11-05' }], now),
    /不晚于上海当天/,
  );
  assert.throws(() => expertReportInput(1, [{ ...row, date: '2026-02-30' }], now), /有效日期/);
  assert.throws(() => expertReportInput(1, [{ ...row, quantity: '-1' }], now), /数量/);
  assert.throws(
    () =>
      expertReportInput(
        1,
        Array.from({ length: 101 }, (_, i) => ({ ...row, key: String(i) })),
        now,
      ),
    /100/,
  );
});
test('corrections use the authorized original returned report only and cannot change member, date or layer', () => {
  const report = {
    ...reportsResponse.examples[0].page.records[0],
    reviewStatus: 'RETURNED',
    allowedActions: ['SAVE_REPORT'],
    quantity: 1e20,
  };
  assert.deepEqual(expertCorrectionInput(1, report, '0', ' 已核对 '), {
    projectId: 1,
    reportId: report.reportId,
    quantity: '0',
    remark: '已核对',
  });
  assert.throws(
    () => expertCorrectionInput(1, { ...report, reviewStatus: 'VERIFIED' }, '1', ''),
    /不可修正/,
  );
  assert.throws(
    () => expertCorrectionInput(1, { ...report, allowedActions: ['VERIFY', 'RETURN'] }, '1', ''),
    /不可修正/,
  );
  assert.throws(() => expertCorrectionInput(1, report, '1', 'x'.repeat(1001)), /最多1000/);
});
