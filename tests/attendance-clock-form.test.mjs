import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../packages/shared/dist/index.js';
import { userResponse } from '../apps/server/src/modules/auth/auth.schema.ts';
import { clockResponse } from '../apps/server/src/modules/attendance/attendance-clock.schema.ts';
import {
  attendanceClockScope,
  attendanceClockInput,
  clockReceiptMatches,
  clockFailureIsUnknown,
} from '../apps/web/src/modules/attendance/attendance-clock.ts';

const first = '00000000-0000-4000-8000-000000000001';
const preferred = '00000000-0000-4000-8000-000000000002';
const organization = { id: preferred, name: '默认组织', joinStatus: 'ACTIVE', position: 'MEMBER' };
const user = {
  ...structuredClone(userResponse.examples[0]),
  role: 'EXPERT',
  selectedRole: 'EXPERT',
  accountType: 'INDIVIDUAL',
  organization,
  organizations: [{ ...organization, id: first }, organization],
};

test('clock scope follows the server default organization and participating relationship instead of array order or account type', () => {
  assert.deepEqual(attendanceClockScope(user), { orgId: preferred, name: '默认组织' });
  for (const joinStatus of ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'])
    assert.equal(
      attendanceClockScope({
        ...user,
        organization: { ...organization, joinStatus },
        organizations: [{ ...organization, joinStatus }],
      }).orgId,
      preferred,
    );
  assert.deepEqual(attendanceClockScope({ ...user, organization: null, organizations: [] }), {
    orgId: null,
    name: '个人考勤',
  });
  assert.equal(
    attendanceClockScope({ ...user, organization: null, organizations: undefined }).orgId,
    null,
  );
});
test('ambiguous or revoked organization identity never becomes personal scope or another organization', () => {
  for (const patch of [
    { organization: null },
    { organization: { ...organization, id: '' } },
    { organization: { ...organization, joinStatus: 'LEFT' } },
    { organizations: [] },
    { organizations: [{ ...organization, id: first }] },
    { selectedRole: 'PM' },
  ])
    assert.throws(() => attendanceClockScope({ ...user, ...patch }));
});
test('clock commands keep only real scope, fixed timezone and the original retry key, while old receipt date and type remain authoritative', () => {
  assert.deepEqual(attendanceClockInput(attendanceClockScope(user), 'original-key'), {
    orgId: preferred,
    timezone: 'Asia/Shanghai',
    idempotencyKey: 'original-key',
  });
  assert.deepEqual(attendanceClockInput({ orgId: null, name: '个人考勤' }, 'original-key'), {
    timezone: 'Asia/Shanghai',
    idempotencyKey: 'original-key',
  });
  const result = {
    ...structuredClone(clockResponse.examples[0]),
    orgId: preferred,
    userId: user.id,
    clockAt: '2026-10-23 09:00:00.000',
  };
  assert.equal(clockReceiptMatches(result, user.id, { orgId: preferred, name: '' }), true);
  assert.equal(
    clockReceiptMatches(result, '00000000-0000-4000-8000-000000000099', {
      orgId: preferred,
      name: '',
    }),
    false,
  );
  assert.equal(clockReceiptMatches(result, user.id, { orgId: null, name: '' }), false);
  assert.equal(
    clockFailureIsUnknown(new ApiError(503, { code: 'SERVICE_ERROR', message: '' })),
    true,
  );
  assert.equal(
    clockFailureIsUnknown(new ApiError(401, { code: 'SESSION_CHANGED', message: '' })),
    true,
  );
  assert.equal(clockFailureIsUnknown(new ApiError(409, { code: 'CONFLICT', message: '' })), false);
  assert.equal(
    clockFailureIsUnknown(new ApiError(408, { code: 'REQUEST_TIMEOUT', message: '' })),
    true,
  );
  assert.equal(clockFailureIsUnknown(new ApiError(200, { code: 500, message: '' })), true);
});
