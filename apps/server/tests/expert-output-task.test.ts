import { beforeEach, expect, test, vi } from 'vitest';
import { expertOutputTask } from '../src/modules/expert/expert-output-task.js';
import { AuthError } from '../src/modules/auth/auth.error.js';
const access = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/production/output-report-access.js', async (original) => ({
  ...(await original<typeof import('../src/modules/production/output-report-access.js')>()),
  outputScope: access,
}));
const principal = { userId: 'self', role: 'EXPERT' } as never;
beforeEach(() => {
  access.mockReset().mockResolvedValue({
    project: { currentNodeCode: 'PRODUCTION_TASK' },
    memberIds: [1, 2, 3],
    all: [
      { id: 1, organizationId: 'a' },
      { id: 2, organizationId: 'b' },
      { id: 3, organizationId: null },
    ],
    organizationIds: ['a'],
    correctionIds: [3],
    reviewer: true,
    readOnly: false,
  });
});
function fixture(rows: { memberId: number; reviewStatus: string }[]) {
  const tx = { projectOutputReport: { findMany: vi.fn().mockResolvedValue(rows) } };
  return {
    tx,
    run: (org: string | null = 'a') => expertOutputTask(tx as never, 1, org, principal, new Date()),
  };
}
test('review requires current organization reviewer permission and queries only writable real sources in the card organization', async () => {
  const f = fixture([{ memberId: 1, reviewStatus: 'PENDING' }]);
  expect(await f.run()).toBe('OUTPUT_DATA_REVIEW');
  expect(f.tx.projectOutputReport.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        projectId: 1,
        member: { organizationId: 'a' },
        memberId: { in: [1, 2, 3] },
        reviewStatus: { in: ['PENDING', 'RETURNED'] },
        OR: [
          { subtaskId: null, project: { currentNodeCode: 'PRODUCTION_TASK' } },
          { subtask: { status: 'IN_PROGRESS' } },
        ],
      },
    }),
  );
  f.tx.projectOutputReport.findMany.mockResolvedValue([{ memberId: 2, reviewStatus: 'PENDING' }]);
  expect(await f.run('b')).toBeNull();
});
test('authorized personal correction restores production and pending review wins; unrelated and verified reports cannot create tasks', async () => {
  const f = fixture([{ memberId: 3, reviewStatus: 'RETURNED' }]);
  expect(await f.run(null)).toBe('PRODUCTION_TASK');
  expect(f.tx.projectOutputReport.findMany.mock.calls[0]![0].where.member).toEqual({
    organizationId: null,
  });
  f.tx.projectOutputReport.findMany.mockResolvedValue([
    { memberId: 3, reviewStatus: 'RETURNED' },
    { memberId: 1, reviewStatus: 'PENDING' },
  ]);
  expect(await f.run()).toBe('OUTPUT_DATA_REVIEW');
  f.tx.projectOutputReport.findMany.mockResolvedValue([
    { memberId: 2, reviewStatus: 'RETURNED' },
    { memberId: 1, reviewStatus: 'VERIFIED' },
  ]);
  expect(await f.run()).toBeNull();
});
test('terminal projects and lost access have no report branch; source failures propagate', async () => {
  const f = fixture([{ memberId: 1, reviewStatus: 'PENDING' }]);
  access.mockResolvedValue({ project: { currentNodeCode: 'COMPLETED' } });
  expect(await f.run()).toBeNull();
  for (const status of [403, 404]) {
    access.mockRejectedValue(new AuthError(status, 'FORBIDDEN', 'access lost'));
    expect(await f.run()).toBeNull();
  }
  expect(f.tx.projectOutputReport.findMany).not.toHaveBeenCalled();
  access.mockRejectedValue(new Error('database failed'));
  await expect(f.run()).rejects.toThrow('database failed');
});
