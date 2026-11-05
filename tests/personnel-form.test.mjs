import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  personnelBody,
  personnelDay,
  personnelEntryInput,
  personnelPerformanceInput,
} from '../apps/web/src/modules/projects/personnel-form.ts';

test('entry decisions use the Shanghai business date, valid calendar days and explicit decision fields', () => {
  const now = new Date('2026-11-03T16:00:00Z');
  assert.throws(() => personnelEntryInput(1, [1], 'YES', '2026-11-03', '', now), /上海当天/);
  assert.deepEqual(personnelEntryInput(1, [1, 2], 'YES', '2026-11-04', 'ignored', now), {
    projectId: 1,
    memberIds: [1, 2],
    entryDecision: 'YES',
    plannedEntryDate: '2026-11-04',
  });
  assert.deepEqual(personnelEntryInput(1, [1], 'NO', '2099-11-04', ' 无法参加 ', now), {
    projectId: 1,
    memberIds: [1],
    entryDecision: 'NO',
    declineReason: '无法参加',
  });
  for (const day of ['2026-02-29', '2026-13-01', '2026-1-01'])
    assert.equal(personnelDay(day), false);
  assert.equal(personnelDay('2024-02-29'), true);
  assert.throws(() => personnelEntryInput(1, [1, 1], 'YES', '2099-01-01', ''), /不同成员/);
  assert.throws(() => personnelEntryInput(1, [1], 'NO', '', ' '.repeat(4)), /放弃原因/);
  assert.throws(
    () =>
      personnelEntryInput(
        1,
        Array.from({ length: 101 }, (_, i) => i + 1),
        'YES',
        '2099-01-01',
        '',
      ),
    /100/,
  );
});
test('performance retains ledger IDs and per-file upload tokens and refuses incomplete uploads or future dates', () => {
  const now = new Date('2026-11-03T15:59:59Z');
  const file = {
    key: 'file',
    file: new File(['evidence'], 'note.txt'),
    uploaded: {
      fileId: 'ledger-id',
      uploadToken: 'one-use-token',
      objectKey: 'member-performance/key',
    },
  };
  assert.deepEqual(personnelPerformanceInput(1, 2, '2026-11-03', ' 完成工作 ', [file], now), {
    projectId: 1,
    memberId: 2,
    recordDate: '2026-11-03',
    content: '完成工作',
    attachmentIds: ['ledger-id'],
    attachmentUploadTokens: { 'ledger-id': 'one-use-token' },
  });
  assert.throws(() => personnelPerformanceInput(1, 2, '2026-11-04', '内容', [], now), /发生日期/);
  assert.throws(
    () =>
      personnelPerformanceInput(
        1,
        2,
        '2026-11-03',
        '内容',
        [{ ...file, uploaded: undefined }],
        now,
      ),
    /上传/,
  );
  assert.throws(
    () => personnelPerformanceInput(1, 2, '2026-11-03', ' '.repeat(2001), [], now),
    /表现内容/,
  );
});
test('personnel request size uses complete UTF-8 JSON rather than character count', () => {
  const prefix = { content: '中'.repeat(5000) };
  assert.equal(personnelBody(prefix), prefix);
  assert.throws(() => personnelBody({ content: '中'.repeat(5500) }), /16 KiB/);
});
