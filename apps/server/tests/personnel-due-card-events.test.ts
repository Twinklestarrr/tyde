import { expect, test, vi } from 'vitest';
import { PersonnelService } from '../src/modules/personnel/personnel.service.js';
import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(async () => ({
    cardChangedRecipients: [{ userId: 'member', role: 'EXPERT' }],
  })),
}));
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({ refreshOwnerProgress: vi.fn() }));
vi.mock('../src/modules/personnel/personnel-access.js', () => ({
  memberInclude: {},
  qualifiedForEntry: () => true,
  personnelScope: vi.fn(),
}));
vi.mock('../src/modules/projects/project-task-rounds.js', () => ({
  collectManagementTasks: async () => ({ scopes: [], sources: [] }),
  managementTaskTypes: [],
  reconcileTaskRounds: vi.fn(),
}));
function fixture() {
  const m = {
    id: 1,
    projectId: 2,
    userId: 'member',
    organizationId: null,
    status: 'PENDING_ENTRY',
    entryDecision: 'YES',
    plannedEntryDate: new Date('2026-10-27'),
  };
  const tx = {
    $queryRaw: vi.fn(),
    projectMember: {
      findMany: vi.fn(async () => [m]),
      findUnique: vi.fn(async () => m),
      update: vi.fn(),
    },
    projectExpertAssignment: { findMany: vi.fn(async () => []) },
    project: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: 2,
        currentNodeCode: 'PRODUCTION_TASK',
        deleted: false,
      })),
    },
    projectProductionPlan: { findUnique: vi.fn(async () => null) },
    projectEventOutbox: { create: vi.fn() },
  };
  const db = { ...tx, $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx) };
  return { tx, service: new PersonnelService(db as never), m };
}
test('scheduled entry activation attaches final card changes to its existing event', async () => {
  const f = fixture();
  expect(await f.service.processDue(new Date('2026-10-27T00:00:00Z'))).toEqual({
    activated: 1,
    skipped: 0,
    failed: 0,
  });
  expect(f.tx.projectEventOutbox.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventType: 'PROJECT_MEMBER_ENTRY_ACTIVATED',
      payload: expect.objectContaining({
        cardChangedRecipients: [{ userId: 'member', role: 'EXPERT' }],
      }),
    }),
  });
  expect(refreshOwnerProgress).toHaveBeenLastCalledWith(f.tx, 2, null, expect.any(Date));
});
test('scheduled entry card failure is counted as a failed transaction without recording activation event', async () => {
  const f = fixture();
  vi.mocked(refreshManagementCardSnapshots).mockRejectedValueOnce(new Error('card fault'));
  expect(await f.service.processDue(new Date('2026-10-27T00:00:00Z'))).toEqual({
    activated: 0,
    skipped: 0,
    failed: 1,
  });
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
test('scheduled entry independent progress failure stops card arbitration and activation event', async () => {
  const f = fixture();
  vi.mocked(refreshManagementCardSnapshots).mockClear();
  vi.mocked(refreshOwnerProgress).mockRejectedValueOnce(new Error('round fault'));
  expect(await f.service.processDue(new Date('2026-10-27T00:00:00Z'))).toEqual({
    activated: 0,
    skipped: 0,
    failed: 1,
  });
  expect(refreshManagementCardSnapshots).not.toHaveBeenCalled();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
