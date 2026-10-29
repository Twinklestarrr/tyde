import { beforeEach, expect, test, vi } from 'vitest';
import {
  canReportExpertOutput,
  hasReportedExpertOutputToday,
} from '../src/modules/expert/expert-report-capability.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
const access = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/production/output-report-access.js', async (original) => ({
  ...(await original<typeof import('../src/modules/production/output-report-access.js')>()),
  outputScope: access,
}));
const principal = { userId: 'self', role: 'EXPERT' } as never;
const now = new Date('2026-10-26T16:01:00Z');
beforeEach(() => {
  access.mockReset();
});
function fixture() {
  const member = {
    userId: 'self',
    organizationId: 'a',
    projectId: 1,
    expertAssignment: {
      status: 'ACCEPTED',
      projectId: 1,
      organizationId: 'a',
      owners: [{ userId: 'self', status: 'ACTIVE', user: { status: 'ACTIVE' } }],
    },
    organization: { deleted: false },
  };
  const scope = {
    project: { currentNodeCode: 'PRODUCTION_TASK' },
    active: [member],
    organizationIds: ['a'],
    readOnly: false,
  };
  access.mockResolvedValue(scope);
  const tx = { projectOutputReport: { findFirst: vi.fn().mockResolvedValue(null) } };
  return {
    member,
    scope,
    tx,
    run: (org: string | null = 'a') => canReportExpertOutput(tx as never, 1, org, principal, now),
  };
}
test('report button uses Shanghai natural date and any own daily report disables it without requiring subtasks', async () => {
  const f = fixture();
  expect(await f.run()).toBe(true);
  expect(f.tx.projectOutputReport.findFirst).toHaveBeenCalledWith({
    where: { projectId: 1, userId: 'self', reportDate: new Date('2026-10-27') },
    select: { id: true },
  });
  f.tx.projectOutputReport.findFirst.mockResolvedValue({ id: 1 });
  expect(await f.run()).toBe(false);
});
test('report button requires active writable membership within the current card organization', async () => {
  const f = fixture();
  expect(await f.run('b')).toBe(false);
  expect(await f.run(null)).toBe(false);
  expect(f.tx.projectOutputReport.findFirst).not.toHaveBeenCalled();
  f.scope.active = [];
  expect(await f.run()).toBe(false);
  f.scope.active = [f.member];
  f.scope.readOnly = true;
  expect(await f.run()).toBe(false);
  f.scope.readOnly = false;
  f.scope.project.currentNodeCode = 'COMPLETED';
  expect(await f.run()).toBe(false);
});
test('only a current assignment owner may report for another active member; supervisor and removed owner cannot', async () => {
  const f = fixture();
  f.member.userId = 'other';
  expect(await f.run()).toBe(true);
  f.member.expertAssignment.owners[0]!.status = 'REMOVED';
  expect(await f.run()).toBe(false);
  f.member.expertAssignment.owners[0]!.status = 'ACTIVE';
  f.scope.organizationIds = [];
  expect(await f.run()).toBe(false);
});
test('lost access returns false while unexpected source failures propagate', async () => {
  const f = fixture();
  for (const status of [403, 404]) {
    access.mockRejectedValue(new AuthError(status, 'FORBIDDEN', 'access lost'));
    expect(await f.run()).toBe(false);
  }
  access.mockRejectedValue(new Error('source unavailable'));
  await expect(f.run()).rejects.toThrow('source unavailable');
});

test('daily visibility switches exactly at Shanghai midnight and source failure is never treated as no report', async () => {
  const f = fixture();
  await hasReportedExpertOutputToday(f.tx as never, 1, 'self', new Date('2026-10-26T15:59:59Z'));
  expect(f.tx.projectOutputReport.findFirst).toHaveBeenLastCalledWith({
    where: { projectId: 1, userId: 'self', reportDate: new Date('2026-10-26') },
    select: { id: true },
  });
  await hasReportedExpertOutputToday(f.tx as never, 1, 'self', new Date('2026-10-26T16:00:00Z'));
  expect(f.tx.projectOutputReport.findFirst).toHaveBeenLastCalledWith({
    where: { projectId: 1, userId: 'self', reportDate: new Date('2026-10-27') },
    select: { id: true },
  });
  f.tx.projectOutputReport.findFirst.mockRejectedValue(new Error('daily read failed'));
  await expect(f.run()).rejects.toThrow('daily read failed');
});
