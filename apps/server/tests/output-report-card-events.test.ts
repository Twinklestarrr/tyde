import { beforeEach, expect, test, vi } from 'vitest';
import { OutputReportService } from '../src/modules/production/output-report.service.js';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
const state = vi.hoisted(() => ({ cards: vi.fn() }));
vi.mock('../src/modules/personnel/personnel.service.js', () => ({ lockPersonnel: vi.fn() }));
vi.mock('../src/modules/projects/project-task-rounds.js', () => ({ reconcileTaskRounds: vi.fn() }));
vi.mock('../src/modules/production/output-report-progress.js', () => ({
  outputTasks: vi.fn(async () => ({ scopes: [], sources: [] })),
  syncOutputSnapshots: state.cards,
}));
vi.mock('../src/modules/production/output-report-access.js', () => ({
  outputScope: vi.fn(async () => ({
    correctionIds: [1],
    reviewer: true,
    readOnly: false,
    organizationIds: null,
  })),
  reportProject: vi.fn(),
  writableReport: vi.fn(),
  reportMembers: vi.fn(),
  isReportOwner: vi.fn(),
  reportConflict: () => new Error('conflict'),
  forbiddenReport: () => new Error('forbidden'),
  reportActions: vi.fn(),
}));
const p = { userId: 'reporter', uid: 'reporter-uid', role: 'EXPERT' } as AuthPrincipal;
const recipients = [
  { userId: 'owner', role: 'EXPERT' as const },
  { userId: 'manager', role: 'PM' as const },
];
beforeEach(() => {
  vi.clearAllMocks();
  state.cards.mockResolvedValue({ cardChangedRecipients: recipients });
});
function fixture() {
  const report = { id: 2, memberId: 1, userId: p.userId, subtaskId: 3, reviewStatus: 'RETURNED' };
  const tx = {
    projectOutputReport: {
      findFirst: vi.fn(async () => report),
      update: vi.fn(),
      findMany: vi.fn(async () => [report]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    projectEventOutbox: { create: vi.fn() },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) };
  const service = new OutputReportService(db as never);
  return {
    tx,
    db,
    report,
    service,
    correct: () => service.correct({ projectId: 4, reportId: 2, quantity: 5 }, p),
  };
}
test('own correction publishes real card changes even when no reporter needs notification', async () => {
  const f = fixture();
  await f.correct();
  expect(f.tx.projectEventOutbox.create).toHaveBeenCalledExactlyOnceWith({
    data: {
      projectId: 4,
      eventType: 'OUTPUT_REPORT_STATE_CHANGED',
      operation: 'PENDING_REVIEW',
      actorUserId: p.userId,
      payload: {
        schemaVersion: 1,
        projectId: 4,
        reporterUserIds: [],
        cardChangedRecipients: recipients,
        actorUserId: p.userId,
      },
    },
  });
});
test('own correction without visible card changes retains its previous silence', async () => {
  const f = fixture();
  state.cards.mockResolvedValue({ cardChangedRecipients: [] });
  await f.correct();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
test('verification remains silent even when it clears manager or expert cards', async () => {
  const f = fixture();
  await f.service.review({ projectId: 4, subtaskId: 3, action: 'VERIFY' }, { ...p, role: 'PM' });
  expect(state.cards).toHaveBeenCalledOnce();
  expect(f.tx.projectEventOutbox.create).not.toHaveBeenCalled();
});
test('delegated correction keeps reporter notification and card-event errors reject the business transaction', async () => {
  const f = fixture();
  f.report.userId = 'departed-reporter';
  state.cards.mockResolvedValue({ cardChangedRecipients: [] });
  await f.correct();
  expect(f.tx.projectEventOutbox.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({ reporterUserIds: ['departed-reporter'] }),
      }),
    }),
  );
  f.report.userId = p.userId;
  state.cards.mockResolvedValue({ cardChangedRecipients: recipients });
  f.tx.projectEventOutbox.create.mockRejectedValueOnce(new Error('card event unavailable'));
  await expect(f.correct()).rejects.toThrow('card event unavailable');
});
