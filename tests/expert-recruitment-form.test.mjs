import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recruitmentPageExample } from '../apps/server/src/modules/projects/project-recruitment.schema.ts';
import {
  newRecruitmentDraft,
  recruitmentCandidateKey,
  recruitmentInput,
} from '../apps/web/src/modules/projects/expert-recruitment-form.ts';

const candidate = recruitmentPageExample.records[0];
function draft(patch = {}) {
  return { ...newRecruitmentDraft(candidate), quantity: '1', operators: '1', ...patch };
}

test('recruitment quantities preserve the 16 integer and 4 decimal range with exact Number round trips', () => {
  for (const [quantity, expected] of [
    ['.0001', 0.0001],
    ['100.1234', 100.1234],
    [' +000100.123400 ', 100.1234],
    ['9007199254740992', 9007199254740992],
    ['9999999999999998', 9999999999999998],
  ]) {
    const input = recruitmentInput(3001, [draft({ quantity })]);
    assert.equal(input.assignments[0].productionRequirement, expected);
  }
  for (const quantity of ['0', '0.00001', '1.12345', '10000000000000000', '-1', '1e4'])
    assert.throws(() => recruitmentInput(3001, [draft({ quantity })]), /招募量级须/);
  for (const quantity of ['9007199254740993', '9007199254740990.1', '9999999999999999'])
    assert.throws(() => recruitmentInput(3001, [draft({ quantity })]), /无法精确提交/);
});

test('recruitment counts require positive 32-bit integers and blank inspection counts remain omitted', () => {
  const input = recruitmentInput(3001, [draft({ operators: ' 2 ', inspectors: ' ' })]);
  assert.equal(input.assignments[0].operatorHeadcount, 2);
  assert.equal(Object.hasOwn(input.assignments[0], 'inspectorHeadcount'), false);
  assert.equal(Object.hasOwn(input.assignments[0], 'sourceRejectedAssignmentId'), false);
  assert.equal(
    recruitmentInput(3001, [draft({ inspectors: '2147483647' })]).assignments[0].inspectorHeadcount,
    2147483647,
  );
  for (const value of ['', '0', '-1', '1.5', '2147483648', '1e2'])
    assert.throws(() => recruitmentInput(3001, [draft({ operators: value })]), /作业人数须/);
  for (const value of ['0', '-1', '1.5', '2147483648', '1e2'])
    assert.throws(() => recruitmentInput(3001, [draft({ inspectors: value })]), /质检人数须/);
});

test('recruitment target identity includes subject type and rejects repeated targets', () => {
  const organization = { ...candidate, subjectType: 'ORGANIZATION', organizationName: '团队' };
  assert.notEqual(recruitmentCandidateKey(candidate), recruitmentCandidateKey(organization));
  const input = recruitmentInput(3001, [draft(), draft({ candidate: organization })]);
  assert.deepEqual(
    input.assignments.map(({ subjectType, subjectId }) => [subjectType, subjectId]),
    [
      ['INDIVIDUAL', candidate.subjectId],
      ['ORGANIZATION', candidate.subjectId],
    ],
  );
  assert.throws(() => recruitmentInput(3001, [draft(), draft()]), /同一批不能重复下发/);
});

test('recruitment preserves the current rejected candidate source and refuses cross-subject replacement', () => {
  const rejected = {
    ...candidate,
    assignment: {
      assignmentId: 17,
      status: 'REJECTED',
      productionRequirement: 12.1234,
      operatorHeadcount: 2,
      inspectorHeadcount: null,
    },
    availableAction: 'RECRUIT_AGAIN',
  };
  const replacement = newRecruitmentDraft(rejected);
  assert.equal(replacement.quantity, '12.1234');
  assert.equal(replacement.operators, '2');
  assert.equal(replacement.inspectors, '');
  const organization = { ...candidate, subjectType: 'ORGANIZATION', organizationName: '新团队' };
  const input = recruitmentInput(3001, [replacement]);
  assert.deepEqual(input.assignments[0], {
    subjectType: rejected.subjectType,
    subjectId: rejected.subjectId,
    productionRequirement: 12.1234,
    operatorHeadcount: 2,
    sourceRejectedAssignmentId: 17,
  });
  assert.throws(
    () => recruitmentInput(3001, [{ ...replacement, candidate: organization }]),
    /当前候选自身的拒单来源/,
  );
});

test('recruitment accepts 100 targets at exactly 16 KiB and rejects overlarge JSON or batch counts', () => {
  const drafts = Array.from({ length: 100 }, (_, index) =>
    draft({
      candidate: {
        ...candidate,
        subjectId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        assignment: index < 39 ? { assignmentId: index + 1, status: 'REJECTED' } : null,
      },
      inspectors: '1',
      sourceRejectedAssignmentId: index < 39 ? index + 1 : null,
    }),
  );
  const initial = recruitmentInput(3001, drafts);
  const remaining = 16 * 1024 - Buffer.byteLength(JSON.stringify(initial), 'utf8');
  assert.ok(remaining > 0 && remaining < 16);
  drafts[0].quantity = '1'.repeat(remaining + 1);
  const exact = recruitmentInput(3001, drafts);
  assert.equal(exact.assignments.length, 100);
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), 16 * 1024);
  drafts[0].quantity += '1';
  assert.throws(() => recruitmentInput(3001, drafts), /超过16 KiB/);
  assert.throws(() => recruitmentInput(3001, [...drafts, draft()]), /1至100/);
  assert.throws(() => recruitmentInput(3001, []), /1至100/);
});
