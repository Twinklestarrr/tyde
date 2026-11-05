import type { PrismaClient } from '@prisma/client';
import { expect, test, vi } from 'vitest';
import type { AuthPrincipal } from '../../src/modules/auth/auth.types.js';
import { ExpertAssignmentService } from '../../src/modules/expert/expert-assignment.service.js';

const principal = { userId: 'owner', role: 'EXPERT' } as AuthPrincipal;
function fixture() {
  const assignment = {
    organizationId: 'org',
    status: 'ACCEPTED',
    projectOwnerUserId: 'member',
    owners: [] as { userId: string; status: string }[],
  };
  const tx = {
    projectExpertAssignment: { findFirst: vi.fn().mockResolvedValue(assignment) },
    userOrgRel: {
      findFirst: vi.fn().mockResolvedValue({ id: 'owner-rel' }),
      findMany: vi.fn().mockResolvedValue([
        {
          position: 'MEMBER',
          user: {
            id: 'member',
            uid: 'member-uid',
            displayName: '昵称',
            realName: '姓名',
            avatarUrl: null,
          },
        },
      ]),
    },
  };
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
  const service = new ExpertAssignmentService(db as unknown as PrismaClient);
  return { assignment, tx, db, service };
}
test('owner candidates reject wrong session roles and invalid IDs before database access', async () => {
  const f = fixture();
  await expect(
    f.service.projectOwnerCandidates(1, { ...principal, role: 'PM' }),
  ).rejects.toMatchObject({ status: 403 });
  for (const id of [0, -1, 1.2, 2147483648, NaN])
    await expect(f.service.projectOwnerCandidates(id, principal)).rejects.toMatchObject({
      status: 400,
    });
  expect(f.db.$transaction).not.toHaveBeenCalled();
});
test('owner candidates stop before listing members when assignment is absent or caller is not its owner', async () => {
  const f = fixture();
  f.tx.projectExpertAssignment.findFirst.mockResolvedValueOnce(null);
  await expect(f.service.projectOwnerCandidates(1, principal)).rejects.toMatchObject({
    status: 404,
  });
  f.tx.userOrgRel.findFirst.mockResolvedValueOnce(null);
  await expect(f.service.projectOwnerCandidates(1, principal)).rejects.toMatchObject({
    status: 403,
  });
  expect(f.tx.userOrgRel.findMany).not.toHaveBeenCalled();
});
test('owner candidates use legacy owner only without relationship history and only after acceptance', async () => {
  const f = fixture();
  expect(await f.service.projectOwnerCandidates(1, principal)).toEqual([
    {
      userId: 'member',
      uid: 'member-uid',
      name: '昵称(姓名)',
      avatarUrl: null,
      position: 'MEMBER',
      projectOwner: true,
    },
  ]);
  f.assignment.owners = [{ userId: 'member', status: 'REMOVED' }];
  expect((await f.service.projectOwnerCandidates(1, principal))[0].projectOwner).toBe(false);
  f.assignment.owners[0].status = 'ACTIVE';
  expect((await f.service.projectOwnerCandidates(1, principal))[0].projectOwner).toBe(true);
  for (const status of ['PENDING_ACCEPTANCE', 'REJECTED', 'CANCELLED']) {
    f.assignment.status = status;
    expect((await f.service.projectOwnerCandidates(1, principal))[0].projectOwner).toBe(false);
  }
});
