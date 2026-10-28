import { refreshOwnerProgress } from '../src/modules/expert/expert-owner-command.js';
vi.mock('../src/modules/expert/expert-owner-command.js', () => ({
  refreshOwnerProgress: vi.fn(async () => undefined),
}));
import type { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import type { AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { ExamCommandService } from '../src/modules/entrance-exams/exam-command.service.js';
import type { ExamConfigInput } from '../src/modules/entrance-exams/exam-config.types.js';
import type { FileRegistryService } from '../src/modules/files/file-registry.service.js';
import { refreshManagementCardSnapshots } from '../src/modules/projects/project-management-card-snapshot.js';
import { reconcileTaskRounds } from '../src/modules/projects/project-task-rounds.js';
vi.mock('../src/modules/projects/project-management-card-snapshot.js', () => ({
  refreshManagementCardSnapshots: vi.fn(async () => ({ cardChangedRecipients: [] })),
}));
vi.mock('../src/modules/projects/project-task-rounds.js', () => ({
  collectManagementTasks: vi.fn(async () => ({ scopes: [], sources: [] })),
  reconcileTaskRounds: vi.fn(async () => undefined),
  managementTaskTypes: ['MAIN_ENTRANCE_EXAM'],
}));
vi.mock('../src/modules/entrance-exams/exam-access.js', () => ({
  requireExamManager: vi.fn(async () => ({ id: 1, currentNodeCode: 'ENTRANCE_EXAM' })),
  requireProjectExam: vi.fn(async () => ({ id: 2, status: 'ACTIVE' })),
}));
vi.mock('../src/modules/entrance-exams/exam-config.js', () => ({
  prepareExamConfig: vi.fn(() => ({ examName: '考试', rounds: [], papers: [] })),
}));
afterEach(() => vi.clearAllMocks());
function fixture() {
  const exam = { id: 2, status: 'ACTIVE', currentVersionId: 3, examNo: 'exam' };
  const tx = {
    $queryRaw: vi.fn(),
    project: { update: vi.fn(async () => ({ id: 1, currentNodeCode: 'STANDARD_TRAINING' })) },
    projectProductionPlan: { findUnique: vi.fn(async () => ({ needWrittenExam: true })) },
    projectEntranceExam: {
      findFirst: vi.fn(async ({ where }) => (where.id === 2 ? exam : null)),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => exam),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    entranceExamVersion: {
      findUnique: vi.fn(async () => ({ examId: 2, versionNo: 1 })),
      create: vi.fn(async () => ({ id: 4 })),
    },
    user: { findMany: vi.fn(async () => []) },
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  const service = new ExamCommandService(db, {} as FileRegistryService);
  const principal = { userId: 'pm', uid: 'pm', role: 'PM' } as AuthPrincipal;
  return { tx, service, principal };
}
test.each(['publish', 'edit', 'close'])(
  '%s refreshes cards after configuration and rounds and propagates failures',
  async (command) => {
    const f = fixture();
    vi.mocked(refreshManagementCardSnapshots).mockImplementationOnce(async (tx, projectId) => {
      expect(tx).toBe(f.tx);
      expect(projectId).toBe(1);
      expect(f.tx.projectEntranceExam.updateMany).toHaveBeenCalledTimes(1);
      expect(reconcileTaskRounds).toHaveBeenCalledTimes(1);
      expect(refreshOwnerProgress).toHaveBeenCalledExactlyOnceWith(f.tx, 1, null, expect.any(Date));
      if (command !== 'close') expect(f.tx.entranceExamVersion.create).toHaveBeenCalledTimes(1);
      throw new Error('config snapshot fault');
    });
    const input = { projectId: 1, examId: 2, expectedCurrentVersionId: 3 };
    await expect(
      command === 'close'
        ? f.service.close(input, f.principal)
        : f.service.save(input as unknown as ExamConfigInput, f.principal, command === 'edit'),
    ).rejects.toThrow('config snapshot fault');
  },
);

test.each(['publish', 'edit', 'close'])(
  '%s propagates independent round failure before card arbitration',
  async (command) => {
    const f = fixture();
    vi.mocked(refreshOwnerProgress).mockRejectedValueOnce(new Error('independent round fault'));
    const input = { projectId: 1, examId: 2, expectedCurrentVersionId: 3 };
    await expect(
      command === 'close'
        ? f.service.close(input, f.principal)
        : f.service.save(input as unknown as ExamConfigInput, f.principal, command === 'edit'),
    ).rejects.toThrow('independent round fault');
    expect(f.tx.projectEntranceExam.updateMany).toHaveBeenCalledOnce();
    expect(reconcileTaskRounds).toHaveBeenCalledOnce();
    expect(refreshManagementCardSnapshots).not.toHaveBeenCalled();
  },
);
